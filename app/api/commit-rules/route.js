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
export async function POST(request) {
  const incoming = await request.json();
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
