import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { getDb, saveDb, logTransaction } from '@/lib/db';

const keyOf = (r) =>
  `${r.match_type}|${r.service_code || ''}|${r.service_category || ''}`;

const PREINGESTED_PATH = path.join(process.cwd(), 'data', 'preIngestedRules.json');

/**
 * POST /api/commit-rules
 *
 * Merges incoming staged rules into:
 *   1. database.json (active CRD memory)
 *   2. data/preIngestedRules.json (canonical on-disk snapshot)
 *
 * The pre-ingested snapshot becomes the durable system of record;
 * `database.json` is its runtime projection. Re-loading the snapshot
 * via the "Use previously ingested rules" button picks up everything
 * that has ever been committed.
 *
 * Match key: match_type + service_code + service_category. First-seen
 * rule wins for any conflicting key; subsequent commits with the same
 * key are no-ops at the data level (but logged).
 */
const MAX_RULES = 10000;
// Headroom over the ~3,154-rule snapshot for live uploads, so repeated
// commits cannot grow the rule index without bound.
const MAX_TOTAL_RULES = 8000;
const VENDORS = ['BCBSIL', 'Carelon', 'Lucet', 'EviCore', 'Carelon-or-BCBSIL-conditional'];
const STRING_FIELDS = [
  'service_code', 'service_category', 'description', 'pa_needed', 'managed_by',
  'questionnaire_id', 'cql_library_id', 'documentation_requirements',
  'effective_date', 'source_file', 'source_label', 'plan_type'
];

// Staged rules come from the extractor, but the route is callable directly,
// so each rule is rebuilt from known fields with string values only.
function normalizeRule(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (!['code', 'category'].includes(r.match_type)) return null;
  const out = { match_type: r.match_type };
  for (const k of STRING_FIELDS) {
    if (r[k] === null || r[k] === undefined) out[k] = null;
    else if (typeof r[k] === 'string') out[k] = r[k].slice(0, 500);
    else return null;
  }
  if (r.match_type === 'code' && !out.service_code) return null;
  if (r.match_type === 'category' && !out.service_category) return null;
  if (!out.description) out.description = out.service_code || out.service_category;
  if (!out.pa_needed) out.pa_needed = 'auth-needed';
  // managed_by picks the UM vendor and lands in the X12 278, so only the
  // known vendors are kept.
  if (!VENDORS.includes(out.managed_by)) out.managed_by = 'BCBSIL';
  if (Number.isInteger(r.source_page)) out.source_page = r.source_page;
  return out;
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'body must be a JSON array of rules' }, { status: 400 });
  }
  if (!Array.isArray(body) || body.length > MAX_RULES) {
    return NextResponse.json({ error: `body must be a JSON array of at most ${MAX_RULES} rules` }, { status: 400 });
  }
  const incoming = body.map(normalizeRule);
  const badIndex = incoming.findIndex((r) => !r);
  if (badIndex >= 0) {
    return NextResponse.json({ error: `rule ${badIndex} is not a valid code or category rule` }, { status: 400 });
  }
  const db = getDb();

  // --- Merge into active DB ---
  const activeByKey = new Map();
  for (const r of db.rules) activeByKey.set(keyOf(r), r);
  let addedActive = 0;
  for (const r of incoming) {
    const k = keyOf(r);
    if (!activeByKey.has(k)) {
      activeByKey.set(k, r);
      addedActive++;
    }
  }
  if (activeByKey.size > MAX_TOTAL_RULES) {
    return NextResponse.json(
      { error: `commit would bring the rule index to ${activeByKey.size} rules, over the ${MAX_TOTAL_RULES} limit` },
      { status: 413 }
    );
  }
  db.rules = Array.from(activeByKey.values());
  saveDb(db);

  // --- Upsert into the canonical pre-ingested snapshot ---
  let snapshotCount = 0;
  let addedSnapshot = 0;
  let perFile = [];
  try {
    let snap;
    if (fs.existsSync(PREINGESTED_PATH)) {
      snap = JSON.parse(fs.readFileSync(PREINGESTED_PATH, 'utf8'));
    } else {
      snap = { perFile: [], totalRules: 0, rules: [] };
    }
    const snapByKey = new Map();
    for (const r of (snap.rules || [])) snapByKey.set(keyOf(r), r);

    // Per-file counts get a fresh tally from the incoming batch
    const filesTouchedThisCommit = new Map();
    for (const r of incoming) {
      const k = keyOf(r);
      if (!snapByKey.has(k)) {
        snapByKey.set(k, r);
        addedSnapshot++;
      }
      // Track per-source counts even for duplicates so the snapshot's
      // perFile metadata reflects every contributor.
      const fname = r.source_file || '(unknown)';
      const label = r.source_label || 'Unknown';
      if (!filesTouchedThisCommit.has(fname)) {
        filesTouchedThisCommit.set(fname, { name: fname, label, addedThisCommit: 0 });
      }
      const entry = filesTouchedThisCommit.get(fname);
      if (!snapByKey.has(k)) entry.addedThisCommit++;
    }

    // Merge perFile metadata: keep existing entries, bump counts, add new
    const existingByName = new Map((snap.perFile || []).map((p) => [p.name, p]));
    for (const [name, info] of filesTouchedThisCommit) {
      const existing = existingByName.get(name);
      const newTotal = Array.from(snapByKey.values()).filter((r) => r.source_file === name).length;
      if (existing) {
        existing.added = newTotal;
        existing.total = newTotal;
        existing.label = info.label;
      } else {
        existingByName.set(name, { name, label: info.label, added: newTotal, total: newTotal });
      }
    }
    perFile = Array.from(existingByName.values());

    const newSnap = {
      generatedAt: new Date().toISOString(),
      extractedFrom: snap.extractedFrom || 'real BCBSIL PA grid PDFs via pdfplumber + accumulated upserts',
      perFile,
      totalRules: snapByKey.size,
      rules: Array.from(snapByKey.values())
    };
    fs.writeFileSync(PREINGESTED_PATH, JSON.stringify(newSnap, null, 2));
    snapshotCount = newSnap.totalRules;
  } catch (e) {
    // If snapshot write fails, the active DB is still updated. Surface
    // the issue in the log but don't fail the request.
    logTransaction(
      'Ingestion Engine',
      'SNAPSHOT WRITE FAIL',
      `Could not persist to preIngestedRules.json: ${e.message || e}`
    );
  }

  logTransaction(
    'Ingestion Engine',
    'STATE COMMIT',
    `Merged ${incoming.length} staged rules. Active: +${addedActive} new (${db.rules.length} total). Snapshot: +${addedSnapshot} new (${snapshotCount || db.rules.length} total).`
  );

  return NextResponse.json({
    success: true,
    activeAdded: addedActive,
    activeTotal: db.rules.length,
    snapshotAdded: addedSnapshot,
    snapshotTotal: snapshotCount,
    duplicate: incoming.length - addedActive
  });
}
