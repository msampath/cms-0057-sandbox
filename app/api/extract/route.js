import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { logTransaction } from '@/lib/db';

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

function runPython(scriptPath, args, timeoutMs = 120000) {
  // Try several Python entry points in order: python3, python, py (Windows
  // launcher). Whichever resolves first wins. ENOENT errors mean "binary
  // not on PATH" — silently fall through to the next candidate.
  const CANDIDATES = ['python3', 'python', 'py'];
  return new Promise((resolve, reject) => {
    let idx = 0;
    const tryNext = () => {
      if (idx >= CANDIDATES.length) {
        return reject(new Error('no Python interpreter found on PATH (tried python3, python, py)'));
      }
      const cmd = CANDIDATES[idx++];
      let stdout = '', stderr = '';
      let resolved = false;
      let proc;
      try {
        proc = spawn(cmd, [scriptPath, ...args], {
          stdio: ['ignore', 'pipe', 'pipe'],
          // Force UTF-8 stdio so the spawned Python doesn't crash when its
          // print() emits non-ASCII characters on Windows (default cp1252).
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
        });
      } catch (e) {
        return tryNext();
      }
      const killer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        if (!resolved) { resolved = true; reject(new Error('extractor timed out')); }
      }, timeoutMs);
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (err) => {
        clearTimeout(killer);
        if (resolved) return;
        if (err.code === 'ENOENT') return tryNext();
        resolved = true; reject(err);
      });
      proc.on('close', (code) => {
        clearTimeout(killer);
        if (resolved) return;
        // Detect the Windows App Execution Alias stub: it prints a
        // "Microsoft Store" redirect message and exits 9009. Treat as
        // "interpreter missing" and try the next candidate.
        const isStoreStub =
          code === 9009 ||
          /Microsoft Store/i.test(stderr + stdout) ||
          /Python was not found/i.test(stderr + stdout) ||
          /App execution aliases/i.test(stderr + stdout);
        if (isStoreStub) return tryNext();
        resolved = true;
        resolve({ code, stdout, stderr, command: cmd });
      });
    };
    tryNext();
  });
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
