import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { logTransaction } from '@/lib/db';
import { runPython } from '@/lib/python';

/**
 * POST /api/extract
 *
 * Accepts a multipart upload (field name: "file"). Runs the local Python
 * extractor (scripts/extractPreIngested.py) against the uploaded PDF and
 * returns the resulting rules.
 *
 * Pipeline:
 *   1. Receive PDF as multipart form-data.
 *   2. Save to a temp file under os.tmpdir().
 *   3. Auto-detect kind from filename (ma / medsurg / pharm / bh).
 *   4. Spawn `python3 scripts/extractPreIngested.py <kind> <pdf> <out_json>`.
 *   5. Read the JSON the script wrote, return it.
 *
 * Requires Python 3 + pdfplumber installed locally. If the script isn't
 * found or pdfplumber is missing, returns 503 with an actionable message.
 */

const KIND_MATCHERS = [
  { re: /\bbh\b|behavioral|mental.health/i,                    kind: 'bh',      label: 'Behavioral Health' },
  { re: /specialty.*pharm|pharmacy|\bspecialty\b/i,            kind: 'pharm',   label: 'Specialty Pharmacy' },
  { re: /\bmapa\b|medicare.?advantage|\bma[-_ ]|[-_ ]ma\b/i,   kind: 'ma',      label: 'Medicare Advantage' },
  { re: /commercial.*med.*surg|med.*surg|commercial/i,         kind: 'medsurg', label: 'Commercial Med-Surg' }
];

function detectKind(filename) {
  for (const m of KIND_MATCHERS) if (m.re.test(filename)) return m;
  return null;
}

export async function POST(request) {
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return NextResponse.json({ error: 'expected multipart/form-data with a "file" field' }, { status: 400 });
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return NextResponse.json({ error: 'no file uploaded under field "file"' }, { status: 400 });
  }

  const filename = file.name || 'upload.pdf';
  const matched = detectKind(filename);
  if (!matched) {
    return NextResponse.json({
      error: 'unrecognized filename pattern',
      hint: 'filename must contain bh / specialty / pharmacy / ma / medicare / medsurg / commercial',
      filename
    }, { status: 422 });
  }

  // Save to temp file
  const buf = Buffer.from(await file.arrayBuffer());
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-extract-'));
  const pdfPath = path.join(tmpDir, filename);
  const outPath = path.join(tmpDir, 'rules.json');
  fs.writeFileSync(pdfPath, buf);

  const scriptPath = path.join(process.cwd(), 'scripts', 'extractPreIngested.py');
  if (!fs.existsSync(scriptPath)) {
    return NextResponse.json({ error: 'scripts/extractPreIngested.py missing' }, { status: 500 });
  }

  logTransaction(
    'Ingestion Engine',
    'LIVE EXTRACT START',
    `Spawning python extractor for ${filename} (kind=${matched.kind}, ${(buf.length / 1024).toFixed(1)} KB)`
  );

  let result;
  try {
    result = await runPython(scriptPath, [matched.kind, pdfPath, outPath]);
  } catch (e) {
    logTransaction('Ingestion Engine', 'LIVE EXTRACT FAIL', String(e.message || e));
    return NextResponse.json({
      error: 'failed to run python extractor',
      hint: 'install Python 3 and pdfplumber: pip install pdfplumber',
      detail: String(e.message || e)
    }, { status: 503 });
  }

  if (result.code !== 0) {
    logTransaction('Ingestion Engine', 'LIVE EXTRACT FAIL', `exit ${result.code}: ${result.stderr.slice(0, 300)}`);
    return NextResponse.json({
      error: 'extractor exited non-zero',
      exitCode: result.code,
      stderr: result.stderr,
      stdout: result.stdout,
      hint: result.stderr.includes('pdfplumber') ? 'install pdfplumber: pip install pdfplumber' : undefined
    }, { status: 500 });
  }

  if (!fs.existsSync(outPath)) {
    return NextResponse.json({ error: 'extractor finished but no JSON file produced' }, { status: 500 });
  }

  const rules = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  // Tag each rule with source label so the UI can show the per-source group.
  for (const r of rules) {
    r.source_file = filename;
    r.source_label = matched.label;
  }

  logTransaction(
    'Ingestion Engine',
    'LIVE EXTRACT OK',
    `Extracted ${rules.length} rules from ${filename} via real PDF parse.`
  );

  // Best-effort cleanup
  try { fs.unlinkSync(pdfPath); fs.unlinkSync(outPath); fs.rmdirSync(tmpDir); } catch {}

  return NextResponse.json({
    success: true,
    filename,
    kind: matched.kind,
    label: matched.label,
    count: rules.length,
    rules
  });
}
