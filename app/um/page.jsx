'use client';
import { useState, useMemo } from 'react';
import useSWR, { mutate as mutateKey } from 'swr';
import Link from 'next/link';
import { apiUrl } from '@/lib/basePath';
import {
  pickPatternForFile,
  buildExceptions,
  summarize,
  groupBySource,
  formatBytes
} from './stagingData';
import { TranslatorToggle, NcpdpToggle } from './translatorDrawer';
import RulesExplorer from './rulesExplorer';
import SchemaExplorer from './schemaExplorer';
import ProviderAccessPanel from './providerAccess';
import P2PExchangePanel from './p2pExchange';
import StandardsPanel from './standardsPanel';
import RegistryMetricsPanel from './registryMetrics';
import ClockBadge from '@/app/components/ClockBadge';

const fetcher = (url) => fetch(url).then((r) => {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
});

const CODE_SHAPE = /^(\d{5}|\d{4}[A-Z]|[A-Z]\d{4})$/;
// Same identity as /api/commit-rules: one grid's answer for one code or category.
const ruleKey = (r) => `${r.match_type}|${r.service_code || ''}|${r.service_category || ''}|${r.source_label || ''}`;
const hasCodeShape = (r) => r.match_type !== 'code' || CODE_SHAPE.test(String(r.service_code || ''));
function codeValidityPct(rules) {
  if (!rules.length) return 0;
  const valid = rules.filter((r) => r.match_type !== 'code' || CODE_SHAPE.test(String(r.service_code || ''))).length;
  return Math.round((valid / rules.length) * 1000) / 10;
}

export default function UmDashboard() {
  // The feed polls only while its tab is open. Other tabs read it once.
  const [tab, setTab] = useState('rules'); // 'rules' | 'feed' | 'provider' | 'p2p' | 'standards' | 'metrics'
  const { data, error: logsError } = useSWR(apiUrl('/api/logs'), fetcher, { refreshInterval: tab === 'feed' ? 2000 : 0 });
  // SWR dedupes by key — both this and <RulesExplorer> share the same
  // cached response, no double fetch. The full rule set is large, so it is
  // polled slowly and revalidated right after a commit, load, or reset.
  const [staging, setStaging] = useState(null);
  const { data: rulesData } = useSWR(apiUrl('/api/rules'), fetcher, { refreshInterval: tab === 'rules' && !staging ? 15000 : 0, revalidateOnFocus: tab === 'rules' && !staging });
  const ruleCount = rulesData?.rules?.length ?? 0;
  // One-shot probe: can this host run the Python extractor? Undefined while
  // loading is treated as available so the form does not flash disabled.
  const { data: extractHealth } = useSWR(apiUrl('/api/extract/health'), fetcher, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false
  });
  const extractorAvailable = extractHealth?.available !== false;
  const [files, setFiles] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleUpload = async (e) => {
    e.preventDefault();
    if (files.length === 0) return;
    setIsProcessing(true);
    try {
      await runExtraction();
    } finally {
      setIsProcessing(false);
    }
  };

  const runExtraction = async () => {

    // Real per-file extraction via the Python-backed /api/extract endpoint.
    // Each file is POSTed as multipart; the server spawns pdfplumber, parses
    // the PDF, returns the extracted rules.
    const perFile = [];
    let allRules = [];
    const errors = [];

    for (const f of files) {
      try {
        const fd = new FormData();
        fd.append('file', f);
        const res = await fetch(apiUrl('/api/extract'), { method: 'POST', body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          errors.push({ name: f.name, error: data.error || `HTTP ${res.status}`, hint: data.hint });
          perFile.push({ source_file: f.name, source_label: 'extraction failed', matched: false, allRules: [], ownRules: [], dupRules: [] });
          continue;
        }
        const rules = data.rules || [];
        perFile.push({
          source_file: f.name,
          source_label: data.label || 'Unclassified',
          matched: true,
          allRules: rules,
          ownRules: rules,
          dupRules: []
        });
        allRules = allRules.concat(rules);
      } catch (err) {
        errors.push({ name: f.name, error: String(err.message || err) });
        perFile.push({ source_file: f.name, source_label: 'extraction failed', matched: false, allRules: [], ownRules: [], dupRules: [] });
      }
    }

    // Cross-file dedupe for the merged commit set. Each file's own and
    // duplicate rules are counted against the files before it.
    const byKey = new Set();
    const rules = [];
    for (const p of perFile) {
      p.ownRules = [];
      p.dupRules = [];
      for (const r of p.allRules) {
        const k = ruleKey(r);
        if (byKey.has(k)) { p.dupRules.push(r); continue; }
        byKey.add(k);
        p.ownRules.push(r);
        rules.push(r);
      }
    }

    const totalExtracted = perFile.reduce((n, p) => n + p.allRules.length, 0);
    const current = await fetch(apiUrl('/api/rules')).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const activeKeys = new Set(((current || rulesData)?.rules || []).map(ruleKey));
    // Rules without a CPT or HCPCS shaped code are left out of the commit,
    // so they are counted apart, not as new or already present.
    const committable = rules.filter(hasCodeShape);
    const newCount = committable.filter((r) => !activeKeys.has(ruleKey(r))).length;
    const skipped = rules.length - committable.length;

    const baseExceptions = buildExceptions(rules, files);
    const allExceptions = [
      ...errors.map((e) => ({ code: 'EXTRACT', issue: `${e.name}: ${e.error}${e.hint ? ` — ${e.hint}` : ''}` })),
      ...baseExceptions
    ];

    setStaging({
      sources: files.map((f) => ({ name: f.name, size: f.size })),
      totalExtracted,
      // Share of extracted rules whose code has a CPT or HCPCS shape.
      // Category rules carry no code and count as valid.
      codeValidity: codeValidityPct(rules),
      rules,
      perFile,
      exceptions: allExceptions,
      diff: { newCount, alreadyPresent: committable.length - newCount, skipped, activeBefore: activeKeys.size },
      extractionErrors: errors
    });
  };

  // Discard staging and return to the upload form. Files remain queued so
  // the user can tweak the list and re-extract.
  const reupload = () => setStaging(null);

  const removeFile = (i) => setFiles((prev) => prev.filter((_, idx) => idx !== i));

  const [committing, setCommitting] = useState(false);
  const commitRules = async () => {
    if (committing) return;
    setCommitting(true);
    // Code rules that fail the code-shape check are left out of the commit.
    const toCommit = staging.rules.filter(hasCodeShape);
    const res = await fetch(apiUrl('/api/commit-rules'), { method: 'POST', body: JSON.stringify(toCommit) }).catch(() => null);
    if (!res?.ok) {
      const json = await res?.json().catch(() => null);
      window.alert(`Commit failed: ${json?.error || (res ? `HTTP ${res.status}` : 'network error')}. The staged rules are kept.`);
      setCommitting(false);
      return;
    }
    setCommitting(false);
    const dropped = staging.rules.length - toCommit.length;
    if (dropped > 0) window.alert(`Committed. ${dropped} code rule${dropped === 1 ? '' : 's'} without a CPT or HCPCS shaped code were left out.`);
    mutateKey(apiUrl('/api/rules'));
    setStaging(null);
    setFiles([]);
  };

  const metrics = useMemo(() => (staging ? summarize(staging.rules) : null), [staging]);
  const perSource = useMemo(
    () => (staging?.perFile ? groupBySource(staging.perFile) : []),
    [staging]
  );

  return (
    <div className="p-8 h-screen bg-gray-900 text-gray-100 font-mono flex flex-col overflow-hidden">
      <div className="border-b border-gray-700 pb-4 mb-4 flex justify-between items-center shrink-0 gap-4 flex-wrap">
        <h1 className="text-2xl font-bold text-green-400">Payer Interop Gateway (UM)</h1>
        <div className="flex gap-1">
          <button
            onClick={() => { setTab('rules'); mutateKey(apiUrl('/api/rules')); }}
            className={`px-3 py-1.5 rounded text-sm ${tab === 'rules' ? 'bg-blue-700 text-white font-semibold' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
          >
            Rules &amp; Schema
          </button>
          <button
            onClick={() => { setTab('feed'); mutateKey(apiUrl('/api/logs')); }}
            className={`px-3 py-1.5 rounded text-sm ${tab === 'feed' ? 'bg-blue-700 text-white font-semibold' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
          >
            Live Traffic Feed {data?.logs && <span className="text-gray-500 text-xs">({data.logs.length})</span>}
          </button>
          <button
            onClick={() => setTab('provider')}
            className={`px-3 py-1.5 rounded text-sm ${tab === 'provider' ? 'bg-blue-700 text-white font-semibold' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
          >
            Provider Access
          </button>
          <button
            onClick={() => setTab('p2p')}
            className={`px-3 py-1.5 rounded text-sm ${tab === 'p2p' ? 'bg-blue-700 text-white font-semibold' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
          >
            P2P Exchange
          </button>
          <button
            onClick={() => setTab('standards')}
            className={`px-3 py-1.5 rounded text-sm ${tab === 'standards' ? 'bg-blue-700 text-white font-semibold' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
          >
            Standards
          </button>
          <button
            onClick={() => setTab('metrics')}
            className={`px-3 py-1.5 rounded text-sm ${tab === 'metrics' ? 'bg-blue-700 text-white font-semibold' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
          >
            Registry &amp; Metrics
          </button>
        </div>
        <div className="flex items-center gap-2">
          <ResetDemoButton onReset={() => setStaging(null)} blocked={isProcessing || committing} />
          <span className="bg-green-900 text-green-300 text-xs px-2 py-1 rounded">SYSTEM: ONLINE</span>
        </div>
      </div>

      {/* Rules & Schema tab — Rules Explorer + Schema Explorer + Pipeline */}
      {tab === 'rules' && (<div className="flex-grow overflow-auto min-h-0">
      {!staging && ruleCount > 0 && (
        <div className="shrink-0">
          <RulesExplorer />
          <SchemaExplorer />
        </div>
      )}
      {!staging && ruleCount === 0 && (
        <div className="shrink-0">
          <SchemaExplorer />
        </div>
      )}

      <div className="mb-6 bg-gray-800 p-4 rounded border border-gray-700 shrink-0 overflow-auto" style={{ maxHeight: '70vh' }}>
        <h2 className="text-lg font-bold text-blue-400 mb-4">
          {staging
            ? 'Rule Management Pipeline'
            : ruleCount === 0
            ? 'Step 1 — Upload PA grids'
            : 'Add more grids'}
        </h2>
        {!staging && ruleCount === 0 && (
          <div className="mb-3">
            <p className="text-sm text-gray-300 mb-3">
              No rules are committed yet. Upload one or more PA grid PDFs to populate the
              CRD engine, or skip ahead by loading the pre-ingested snapshot covering all
              four canonical grids (Medicare Advantage, Commercial Med-Surg, Specialty
              Pharmacy, Behavioral Health).
            </p>
            <PreIngestedButton />
          </div>
        )}
        {!staging && ruleCount > 0 && (
          <div className="mb-3">
            <p className="text-xs text-gray-400 mb-3">
              Upload an additional grid below — the staging review will diff its extracted
              rules against the {ruleCount} already in active CRD memory.
            </p>
            <PreIngestedButton ruleCount={ruleCount} />
            <EmptyStateResetLink onReset={() => setStaging(null)} blocked={isProcessing || committing} />
          </div>
        )}

        {!staging ? (
          <UploadForm
            files={files}
            setFiles={setFiles}
            removeFile={removeFile}
            onSubmit={handleUpload}
            isProcessing={isProcessing}
            extractorAvailable={extractorAvailable}
          />
        ) : (
          <StagingReview
            staging={staging}
            metrics={metrics}
            perSource={perSource}
            onCommit={commitRules}
            committing={committing}
            onReupload={reupload}
          />
        )}
      </div>
      </div>)}

      {tab === 'provider' && (
        <div className="flex-grow overflow-auto">
          <div className="flex justify-between items-center mb-4 shrink-0">
            <div>
              <h2 className="text-lg font-bold text-gray-400">Provider Access API</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                45 CFR 156.222(a) — Da Vinci PDex IG · SMART on FHIR v2 (backend-services) · Effective Jan 1, 2027
              </p>
            </div>
            <Link href="/patient" className="text-xs text-blue-400 hover:text-blue-300 underline">
              Patient Access portal →
            </Link>
          </div>
          <ProviderAccessPanel />
        </div>
      )}

      {tab === 'p2p' && (
        <div className="flex-grow overflow-auto">
          <div className="mb-4 shrink-0">
            <h2 className="text-lg font-bold text-gray-400">Payer-to-Payer Exchange</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              45 CFR 156.222(b) — Da Vinci PDex IG ($member-match + bulk FHIR export) · Effective Jan 1, 2027
            </p>
          </div>
          <P2PExchangePanel />
        </div>
      )}

      {tab === 'metrics' && (
        <div className="flex-grow overflow-auto">
          <div className="mb-4 shrink-0">
            <h2 className="text-lg font-bold text-gray-400">Registry and metrics</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              CMS-0062-P (proposed) · endpoint reporting · API usage metrics · PA metrics
            </p>
          </div>
          <RegistryMetricsPanel />
        </div>
      )}

      {tab === 'standards' && (
        <div className="flex-grow overflow-auto">
          <div className="mb-4 shrink-0">
            <h2 className="text-lg font-bold text-gray-400">Standards and dates</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              CMS-0062-P (proposed) · 45 CFR 170.215 implementation guides · HIPAA transaction standards
            </p>
          </div>
          <StandardsPanel />
        </div>
      )}

      {tab === 'feed' && (
        <div className="flex-grow flex flex-col min-h-0">
          <div className="flex justify-between items-center mb-2 shrink-0">
            <h2 className="text-lg font-bold text-gray-400">Live Traffic Feed</h2>
            <button
              onClick={async () => {
                if (!confirm('Clear the Live Traffic Feed? Rules and schema are untouched.')) return;
                await fetch(apiUrl('/api/logs/clear'), { method: 'POST' }).catch(() => {});
                mutateKey(apiUrl('/api/logs'));
      // Provider Access panels read state the reset cleared.
      mutateKey((key) => typeof key === 'string' && key.includes('/api/provider-access'));
              }}
              className="text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 px-3 py-1 rounded"
            >
              Clear feed
            </button>
          </div>
          <div className="flex-grow overflow-auto bg-black p-4 rounded border border-gray-700 shadow-inner">
        {!data && !logsError && <p>Initializing EDI/FHIR Bus…</p>}
        {logsError && <p className="text-red-300">Live feed unavailable ({logsError.message}). Retrying.</p>}
        {data?.logs.map((log) => {
          const isStructured = log.details && typeof log.details === 'object';
          return (
            <div key={log.id} className="mb-4 text-sm whitespace-pre-wrap">
              <span className="text-gray-500">[{new Date(log.timestamp).toLocaleTimeString()}]</span>{' '}
              <span className="text-blue-400 font-bold">[{log.actor}]</span>{' '}
              <span className={`font-bold ${actionColor(log.action)}`}>{log.action}:</span>{' '}
              {isStructured ? (
                <>
                  <span className="text-gray-300">
                    {log.details.note ||
                      (log.details.kind ? 'Structured payload — see expander below.' : JSON.stringify(log.details))}
                  </span>
                  <TranslatorToggle payload={log.details} />
                  <NcpdpToggle payload={log.details} />
                </>
              ) : (
                <span className="text-gray-300">{log.details}</span>
              )}
              {log.clock && <ClockBadge clock={log.clock} decidedAt={log.decidedAt} tone="dark" />}
            </div>
          );
        })}
          </div>
        </div>
      )}
    </div>
  );
}

function ResetDemoButton({ onReset, blocked = false }) {
  const [busy, setBusy] = useState(false);
  const reset = async () => {
    if (
      !confirm(
        'Restore the demo to its seeded baseline? The rule index, live feed, and pending requests return to the first-boot state.'
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(apiUrl('/api/demo/reset?mode=seeded'), { method: 'POST' }).catch(() => null);
      if (!res?.ok) window.alert(`Reset failed: ${res ? `HTTP ${res.status}` : 'network error'}.`);
      else onReset?.();
      mutateKey(apiUrl('/api/rules'));
      mutateKey(apiUrl('/api/logs'));
      // Provider Access panels read state the reset cleared.
      mutateKey((key) => typeof key === 'string' && key.includes('/api/provider-access'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={reset}
      disabled={busy || blocked}
      className="text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 px-3 py-1 rounded disabled:opacity-50"
      title="Restore snapshot rules and replayed demo traffic"
    >
      {busy ? 'Resetting…' : 'Reset demo'}
    </button>
  );
}

function EmptyStateResetLink({ onReset, blocked = false }) {
  const [busy, setBusy] = useState(false);
  const resetEmpty = async () => {
    if (
      !confirm(
        'Clear all rules and the live feed? This leaves an empty index so the upload → staging → commit pipeline can be walked through from a cold start. Use Reset demo to return to the seeded baseline.'
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(apiUrl('/api/demo/reset?mode=empty'), { method: 'POST' }).catch(() => null);
      if (!res?.ok) window.alert(`Reset failed: ${res ? `HTTP ${res.status}` : 'network error'}.`);
      else onReset?.();
      mutateKey(apiUrl('/api/rules'));
      mutateKey(apiUrl('/api/logs'));
      // Provider Access panels read state the reset cleared.
      mutateKey((key) => typeof key === 'string' && key.includes('/api/provider-access'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={resetEmpty}
      disabled={busy || blocked}
      className="mt-2 text-xs text-gray-400 hover:text-gray-200 underline disabled:opacity-50"
    >
      {busy ? 'Clearing…' : 'Reset to an empty index (for the upload walkthrough)'}
    </button>
  );
}

function PreIngestedButton({ ruleCount = 0 }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const alreadyLoaded = ruleCount > 0;
  const load = async () => {
    if (alreadyLoaded && !confirm(`Replace the ${ruleCount} rules currently in active CRD memory with the pre-ingested snapshot? This wipes any custom uploads.`)) {
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(apiUrl('/api/rules/load-pre-ingested'), { method: 'POST' });
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      setResult(res.ok ? data : { error: data?.error || `HTTP ${res.status}` });
      if (res.ok) mutateKey(apiUrl('/api/rules'));
    } catch (e) {
      setResult({ error: e.message || 'network error' });
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="border border-blue-900 bg-blue-950/40 rounded p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div>
          <div className="text-blue-300 text-sm font-bold">
            {alreadyLoaded
              ? 'Reload pre-ingested rule snapshot'
              : 'Skip the upload — use pre-ingested rules'}
          </div>
          <div className="text-[11px] text-gray-400 mt-0.5">
            {alreadyLoaded
              ? `Replaces active CRD memory (currently ${ruleCount} rules) with the canonical snapshot from data/preIngestedRules.json.`
              : 'Loads the canonical snapshot (~3,154 rules across four grids) into active memory.'}
          </div>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className={`px-3 py-2 rounded text-white text-sm font-semibold disabled:opacity-50 ${alreadyLoaded ? 'bg-slate-700 hover:bg-slate-600' : 'bg-blue-700 hover:bg-blue-600'}`}
        >
          {loading
            ? 'Loading…'
            : alreadyLoaded
            ? 'Reload snapshot'
            : 'Use previously ingested rules'}
        </button>
      </div>
      {result?.success && (
        <div className="text-[11px] text-emerald-200">
          ✓ Loaded {result.count} rules. The Rules Explorer above will refresh momentarily.
        </div>
      )}
      {result?.error && (
        <div className="text-[11px] text-red-300">Error: {result.error}</div>
      )}
    </div>
  );
}

function UploadForm({ files, setFiles, removeFile, onSubmit, isProcessing, extractorAvailable = true }) {
  return (
    <form onSubmit={onSubmit}>
      {!extractorAvailable && (
        <div className="mb-3 bg-amber-950/40 border border-amber-700 rounded p-3 text-xs text-amber-200">
          Live PDF extraction is unavailable on this host because Python with
          pdfplumber was not found. The pre-ingested snapshot above covers the
          same four grids, so the rest of the demo is unaffected.
        </div>
      )}
      <div className="flex gap-4 items-start flex-wrap">
        <input
          type="file"
          multiple
          disabled={!extractorAvailable}
          onChange={(e) => {
            const picked = Array.from(e.target.files || []);
            // Cleared so the same file can be picked again after removal.
            e.target.value = '';
            setFiles((prev) => {
              const incoming = picked;
              const seen = new Set(prev.map((f) => `${f.name}:${f.size}:${f.lastModified}`));
              const merged = [...prev];
              for (const f of incoming) {
                const key = `${f.name}:${f.size}:${f.lastModified}`;
                if (!seen.has(key)) {
                  merged.push(f);
                  seen.add(key);
                }
              }
              return merged;
            });
          }}
          className="text-sm file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:bg-gray-700 file:text-gray-200"
          accept=".pdf"
        />
        <button
          type="submit"
          disabled={files.length === 0 || isProcessing || !extractorAvailable}
          className="bg-blue-600 px-4 py-2 rounded text-white font-bold disabled:opacity-50 whitespace-nowrap"
        >
          {isProcessing
            ? 'Parsing PDF…'
            : `Extract rules (pdfplumber)${files.length > 0 ? ` — ${files.length} file${files.length === 1 ? '' : 's'}` : ''}`}
        </button>
      </div>

      {files.length > 0 && (
        <div className="mt-3">
          <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">
            Grids queued for ingestion ({files.length})
          </div>
          <ul className="text-xs space-y-1">
            {files.map((f, i) => {
              const pattern = pickPatternForFile(f.name);
              return (
                <li
                  key={`${f.name}:${f.size}:${i}`}
                  className="bg-gray-900 px-2 py-1 rounded border border-gray-700 flex items-center justify-between gap-2"
                >
                  <span className="text-gray-200 truncate flex-1">{f.name}</span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded shrink-0 ${pattern ? 'bg-blue-900 text-blue-200' : 'bg-yellow-900 text-yellow-200'}`}
                  >
                    {pattern ? pattern.label : 'unrecognized'}
                  </span>
                  <span className="text-gray-500 shrink-0">{formatBytes(f.size)}</span>
                  <button
                    type="button"
                    onClick={() => removeFile(i)}
                    className="text-red-400 hover:text-red-300 text-xs px-1 shrink-0"
                    aria-label={`Remove ${f.name}`}
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            onClick={() => setFiles([])}
            className="mt-2 text-xs text-gray-400 hover:text-gray-200 underline"
          >
            Clear all
          </button>
        </div>
      )}
    </form>
  );
}

function StagingReview({ staging, metrics, perSource, onCommit, committing = false, onReupload }) {
  return (
    <div className="bg-gray-900 p-4 rounded border border-yellow-600">
      <div className="flex justify-between items-start mb-4 gap-4">
        <div className="flex-1">
          <h3 className="text-yellow-500 font-bold">Staging Review (Quality Gate)</h3>
          <div className="text-xs text-gray-400 mt-1">
            {staging.sources.length} grid{staging.sources.length === 1 ? '' : 's'} ingested
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onReupload}
            disabled={committing}
            className="bg-slate-700 hover:bg-slate-600 disabled:opacity-50 px-3 py-2 rounded text-slate-100 text-sm whitespace-nowrap"
          >
            ← Back / Re-upload
          </button>
          <button
            onClick={onCommit}
            disabled={committing || staging.codeValidity < 95}
            className="bg-green-600 px-4 py-2 rounded text-white font-bold disabled:opacity-50 whitespace-nowrap"
          >
            {committing ? 'Committing…' : <>Approve &amp; Commit to CRD Engine</>}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-4 text-sm">
        <Kpi label="Total Codes" value={staging.totalExtracted} />
        <Kpi label="Auth Req Rate" value={`${metrics.authRate}%`} />
        <Kpi label="DTR Coverage" value={`${metrics.dtrCoverage}%`} />
        <div className={`bg-gray-800 p-2 rounded border-b-2 ${staging.codeValidity >= 95 ? 'border-green-500' : 'border-red-500'}`}>
          Code Validity: <span className="text-white font-bold">{staging.codeValidity}%</span>
        </div>
      </div>

      {staging.diff && staging.diff.activeBefore > 0 && (
        <div className="bg-cyan-950/40 border border-cyan-700 rounded p-3 mb-3 text-xs">
          <div className="text-cyan-200 font-bold mb-1">Diff against active CRD memory</div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-400">Already in active index</div>
              <div className="text-2xl font-bold text-gray-200">{staging.diff.activeBefore}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-emerald-300">+ New from this staging</div>
              <div className="text-2xl font-bold text-emerald-200">{staging.diff.newCount}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-amber-300">Already present (no-op)</div>
              <div className="text-2xl font-bold text-amber-200">{staging.diff.alreadyPresent}</div>
            </div>
          </div>
          <div className="text-[11px] text-gray-400 mt-2">
            Commit merges staged rules into active memory. Only the {staging.diff.newCount} new
            rule{staging.diff.newCount === 1 ? '' : 's'} will be added. The rest are already known.
            {staging.diff.skipped > 0 && (
              <> {staging.diff.skipped} code rule{staging.diff.skipped === 1 ? '' : 's'} without a CPT or HCPCS shaped code will be left out.</>
            )}
          </div>
        </div>
      )}

      <PerSourcePanel perSource={perSource} />

      <KpiPanel title="Routing distribution — aggregate (managed_by)">
        <div className="grid grid-cols-3 md:grid-cols-5 gap-2 text-xs">
          {Object.entries(metrics.routingPct).map(([vendor, pct]) => (
            <div key={vendor} className="bg-gray-900 p-2 rounded border border-gray-700">
              <div className="text-gray-400">{vendor}</div>
              <div className="text-white text-base font-bold">{pct}%</div>
            </div>
          ))}
        </div>
      </KpiPanel>

      <KpiPanel title="Rule-type distribution — aggregate (match_type)">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="bg-gray-900 p-2 rounded border border-gray-700">
            <div className="text-gray-400">code-match</div>
            <div className="text-white text-base font-bold">
              {metrics.codePct}%
              <span className="text-gray-500 text-xs"> ({metrics.codeCount})</span>
            </div>
          </div>
          <div className="bg-gray-900 p-2 rounded border border-purple-700">
            <div className="text-purple-300">category-match (BH)</div>
            <div className="text-white text-base font-bold">
              {metrics.categoryPct}%
              <span className="text-gray-500 text-xs"> ({metrics.categoryCount})</span>
            </div>
          </div>
        </div>
      </KpiPanel>

      {staging.rules.some((r) => r.match_type === 'category') && (
        <div className="bg-purple-950/40 border border-purple-700 p-3 rounded mb-3 text-sm">
          <div className="text-purple-300 font-bold mb-1">
            Category-match rules (BH grid — review separately)
          </div>
          <ul className="list-disc pl-5 text-purple-100 text-xs space-y-0.5">
            {staging.rules
              .filter((r) => r.match_type === 'category')
              .map((r, i) => (
                <li key={i}>
                  <span className="font-semibold">{r.service_category}</span>
                  {' → '}
                  <span className="text-purple-300">{r.managed_by}</span>
                  {' · Q: '}
                  <code>{r.questionnaire_id || '—'}</code>
                  {' · from '}
                  <code className="text-gray-300">{r.source_file}</code>
                </li>
              ))}
          </ul>
        </div>
      )}

      <div className="text-sm text-red-400">
        <strong>Exceptions Requiring Review:</strong>
        <ul className="list-disc pl-5 mt-1">
          {staging.exceptions.map((ex, i) => (
            <li key={i}>[{ex.code}] {ex.issue}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function PerSourcePanel({ perSource }) {
  return (
    <KpiPanel title={`Per-source summary (${perSource.length} file${perSource.length === 1 ? '' : 's'})`}>
      <div className="space-y-2">
        {perSource.map((g, i) => (
          <div
            key={`${g.source_file}:${i}`}
            className={`bg-gray-900 p-2 rounded border ${g.matched ? 'border-gray-700' : 'border-yellow-700'}`}
          >
            <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
              <code className="text-gray-100 text-xs truncate flex-1 min-w-0">{g.source_file}</code>
              <span
                className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded shrink-0 ${g.matched ? 'bg-blue-900 text-blue-200' : 'bg-yellow-900 text-yellow-200'}`}
              >
                {g.source_label}
              </span>
              <span className="text-[10px] text-gray-400 shrink-0">
                <span className="text-emerald-300 font-semibold">{g.ownCount}</span> unique
                {g.dupCount > 0 && (
                  <>
                    {' · '}
                    <span className="text-amber-300 font-semibold">{g.dupCount}</span> duplicate
                  </>
                )}
              </span>
            </div>
            <div className="grid grid-cols-4 gap-2 text-[11px]">
              <Mini label="rules" value={g.metrics.total} />
              <Mini label="auth-needed" value={`${g.metrics.authRate}%`} />
              <Mini label="DTR coverage" value={`${g.metrics.dtrCoverage}%`} />
              <Mini
                label="category-match"
                value={
                  <>
                    {g.metrics.categoryCount}
                    {g.metrics.categoryCount > 0 && (
                      <span className="text-purple-300 text-[10px]"> ({g.metrics.categoryPct}%)</span>
                    )}
                  </>
                }
              />
            </div>
            <div className="mt-1 text-[10px] text-gray-500">
              Routes:&nbsp;
              {Object.entries(g.metrics.routingPct).map(([v, p], idx, arr) => (
                <span key={v}>
                  <span className="text-gray-300">{v}</span> {p}%
                  {idx < arr.length - 1 ? ', ' : ''}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </KpiPanel>
  );
}

function Kpi({ label, value }) {
  return (
    <div className="bg-gray-800 p-2 rounded">
      {label}: <span className="text-white font-bold">{value}</span>
    </div>
  );
}

function Mini({ label, value }) {
  return (
    <div>
      <div className="text-gray-500">{label}</div>
      <div className="text-white font-bold">{value}</div>
    </div>
  );
}

function KpiPanel({ title, children }) {
  return (
    <div className="bg-gray-800/70 p-3 rounded border border-gray-700 mb-3">
      <div className="text-xs uppercase tracking-wide text-blue-300 mb-2">{title}</div>
      {children}
    </div>
  );
}

function actionColor(action) {
  if (/X12 278/i.test(action)) return 'text-cyan-300';
  if (/NCPDP|DRUG PA/i.test(action)) return 'text-teal-300';
  if (/COVERAGE-INFORMATION/i.test(action)) return 'text-fuchsia-400';
  if (/EVALUATION|HOOK/i.test(action)) return 'text-yellow-400';
  if (/COMMIT/i.test(action)) return 'text-green-400';
  return 'text-yellow-400';
}
