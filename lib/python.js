import { spawn } from 'child_process';

/**
 * Shared Python spawn helper.
 *
 * Used by /api/extract (live PDF extraction) and /api/extract/health (the
 * availability probe behind the UM upload form). Tries several entry points
 * in order: python3, python, py (Windows launcher). ENOENT and the Windows
 * Store alias stub both mean "this candidate is not a real interpreter" and
 * fall through to the next one.
 */
export function runPython(scriptPath, args, timeoutMs = 120000) {
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

// One probe per process — Python availability does not change while the
// server runs, and the UM dashboard polls nothing here anyway.
let _probePromise = null;

export function probePdfExtraction() {
  if (!_probePromise) {
    _probePromise = runPython('-c', ['import pdfplumber'], 15000)
      .then((r) =>
        r.code === 0
          ? { available: true, detail: `pdfplumber importable via ${r.command}` }
          : {
              available: false,
              detail:
                'a Python interpreter was found but pdfplumber is not installed (pip install pdfplumber)'
            }
      )
      .catch((e) => ({ available: false, detail: String(e.message || e) }));
  }
  return _probePromise;
}
