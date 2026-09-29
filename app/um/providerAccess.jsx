'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { apiUrl } from '@/lib/basePath';
import { authedFetch, getDemoToken, decodeJwtPayload } from '@/lib/smartClient';
import { PATIENT_LIST } from '@/lib/patients';
import { OPTUM_SANDBOX_MEMBER_LIST } from '@/lib/optumSandboxMembers';
import DrugPriorAuths from '@/app/components/DrugPriorAuths';
import { sandboxResponseLabel } from '@/lib/integrationLabel';

const NPI_OPTIONS = [
  { npi: '1234567890', label: 'NPI 1234567890 — Ada Smith, MD' },
  { npi: 'GOLD-NPI-0001', label: 'NPI GOLD-NPI-0001 — Raj Patel, MD (Gold Card)' },
];

const SYSTEM_SCOPES = [
  'system/Patient.read',
  'system/ExplanationOfBenefit.read',
  'system/ClaimResponse.read'
];

const fetcher = (url) => authedFetch(url, SYSTEM_SCOPES).then((r) => r.json());

export default function ProviderAccessPanel() {
  const [npi, setNpi] = useState('1234567890');
  const [queried, setQueried] = useState(null);
  const [expandedPatient, setExpandedPatient] = useState(null);
  const [optumResult, setOptumResult] = useState(null);
  const [optumLoading, setOptumLoading] = useState(false);
  const [optumSource, setOptumSource] = useState('sandbox');
  const [optumSandboxMemberId, setOptumSandboxMemberId] = useState(OPTUM_SANDBOX_MEMBER_LIST[0].id);
  const [optumPatientId, setOptumPatientId] = useState(PATIENT_LIST[0].id);

  const checkOptum = async () => {
    setOptumResult(null);
    setExportKickoff(null);
    setExportManifest(null);
    setExportDownload(null);
    setOptumLoading(true);
    try {
      // npi is threaded through so the log entry appears in the
      // NPI-scoped panel above -- /api/provider-access filters by
      // entry.npi and would otherwise drop this event.
      const payload = optumSource === 'sandbox'
        ? { source: 'sandbox', sandboxMemberId: optumSandboxMemberId, npi }
        : { source: 'demo', patientId: optumPatientId, npi };
      const res = await fetch(apiUrl('/api/optum/provider-member-match'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      setOptumResult({ ok: res.ok, status: res.status, json });
    } catch (e) {
      setOptumResult({ ok: false, json: { error: e.message } });
    }
    setOptumLoading(false);
  };

  // ---- Bulk export chain state (steps 2 & 3 chain off step 1's jobId
  // and the manifest's fileName; groupId defaults to the matched group
  // id from the member-match response) ----
  const [exportGroupId, setExportGroupId] = useState('provider-matched-group-001');
  const [exportKickoff, setExportKickoff] = useState(null);
  const [exportManifest, setExportManifest] = useState(null);
  const [exportDownload, setExportDownload] = useState(null);
  const [exportBusy, setExportBusy] = useState(null); // 'kickoff' | 'status' | 'download' | null

  const runKickoff = async () => {
    setExportBusy('kickoff');
    setExportKickoff(null);
    setExportManifest(null);
    setExportDownload(null);
    try {
      const res = await fetch(apiUrl('/api/optum/export/kickoff'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: exportGroupId })
      });
      const json = await res.json();
      setExportKickoff({ ok: res.ok, status: res.status, json });
    } catch (e) {
      setExportKickoff({ ok: false, json: { error: e.message } });
    }
    setExportBusy(null);
  };

  const runStatusPoll = async () => {
    const jobId = exportKickoff?.json?.jobId;
    if (!jobId) return;
    setExportBusy('status');
    setExportManifest(null);
    setExportDownload(null);
    try {
      const res = await fetch(apiUrl(`/api/optum/export/status/${encodeURIComponent(jobId)}`));
      const json = await res.json();
      setExportManifest({ ok: res.ok, status: res.status, json });
    } catch (e) {
      setExportManifest({ ok: false, json: { error: e.message } });
    }
    setExportBusy(null);
  };

  const runDownload = async (fileUrl) => {
    // Two URL shapes to handle:
    //   Live:  .../R4/{payerId}/{lob}/download/Group/{fileName}/$davinci-data-export
    //   Mock:  mock://{fileName}
    // We only care about {fileName} because the download route rebuilds
    // the full Optum URL from the payerId/lob configured server-side.
    // Strip the trailing operation suffix first, then take the last
    // path segment.
    const url = (fileUrl || '').replace(/\/\$davinci-data-export\/?$/, '');
    const fileName = url.split('/').pop() || 'Patient_file_1.ndjson';
    setExportBusy('download');
    setExportDownload(null);
    try {
      const res = await fetch(apiUrl(`/api/optum/export/download/${encodeURIComponent(fileName)}`));
      const json = await res.json();
      setExportDownload({ ok: res.ok, status: res.status, json });
    } catch (e) {
      setExportDownload({ ok: false, json: { error: e.message } });
    }
    setExportBusy(null);
  };

  // When the SUBMITTED subject actually lands in MatchedMembers,
  // capture the group id so the export panel's groupId defaults to it
  // -- ties the two flows into one story. Mere presence of a
  // MatchedMembers group is not enough: the mock (and Optum's canned
  // live response) always returns all three groups populated, so we
  // must check the submitted subject's identifier or name against the
  // group's contained[] Patients.
  const matchedGroupId = (() => {
    const params = optumResult?.json?.response?.parameter || [];
    const g = params.find((p) => p.name === 'MatchedMembers');
    if (!g?.resource?.id) return null;
    const subjIdent = optumResult?.json?.subject?.identifier || '';
    const subjName = optumResult?.json?.subject?.name || '';
    const contained = g.resource.contained || [];
    const hasSubject = contained.some((c) => {
      const ids = (c?.identifier || []).map((i) => i?.value || '').join(' ');
      const nm = `${(c?.name?.[0]?.given || []).join(' ')} ${c?.name?.[0]?.family || ''}`.trim();
      return (
        (subjIdent && ids.includes(subjIdent)) ||
        (subjName && nm.toLowerCase() === subjName.trim().toLowerCase())
      );
    });
    return hasSubject ? g.resource.id : null;
  })();

  const { data, isLoading } = useSWR(
    queried ? apiUrl(`/api/provider-access?npi=${encodeURIComponent(queried)}`) : null,
    fetcher
  );

  return (
    <div className="flex flex-col gap-4">
      {/* SMART auth notice + 401 demo beat */}
      <SmartAuthBanner />

      {/* NPI lookup */}
      <div className="bg-gray-800 rounded border border-gray-700 p-4">
        <div className="text-sm font-bold text-blue-300 mb-3">Provider NPI lookup — attributed patient panel</div>
        <div className="flex gap-2 flex-wrap items-end">
          <div className="flex-1 min-w-48">
            <label className="text-xs text-gray-400 block mb-1">Select NPI</label>
            <select
              value={npi}
              onChange={(e) => setNpi(e.target.value)}
              className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
            >
              {NPI_OPTIONS.map((o) => (
                <option key={o.npi} value={o.npi}>{o.label}</option>
              ))}
            </select>
          </div>
          <button
            onClick={() => { setQueried(npi); setExpandedPatient(null); }}
            className="bg-blue-700 hover:bg-blue-600 text-white text-sm font-semibold px-4 py-1.5 rounded"
          >
            Retrieve panel
          </button>
          {queried && (
            <button
              onClick={() => { setQueried(null); setExpandedPatient(null); }}
              className="text-xs text-gray-400 hover:text-gray-200 underline"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Optum real Provider Access -- Da Vinci PDex $bulk-member-match */}
      <div className="bg-violet-950/30 rounded border border-violet-800 p-4">
        <div className="text-xs uppercase tracking-widest text-violet-400 mb-2">
          Optum sandbox · Provider Access ($bulk-member-match)
        </div>
        <p className="text-xs text-gray-400 mb-3">
          A second, independent payer&apos;s implementation of the same CMS-0057-F Provider Access concept — Optum&apos;s own Da Vinci PDex multi-member-match. Two source choices below make two different points: submitting an Optum sandbox member returns them in <span className="font-mono">MatchedMembers</span> (their sandbox&apos;s canned data recognizes those exact demographics); submitting one of this sandbox&apos;s own demo patients does not — Optum&apos;s roster does not know them — which is the honest outcome. In live mode that still shows the request reached Optum&apos;s sandbox. In saved-copy mode no call is made and the panel shows a stored sandbox response.
        </p>

        <div className="flex gap-2 flex-wrap items-end mb-3">
          <div className="min-w-40">
            <label className="text-xs text-gray-400 block mb-1">Source</label>
            <select
              value={optumSource}
              onChange={(e) => setOptumSource(e.target.value)}
              className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-violet-500"
            >
              <option value="sandbox">Sandbox members (Optum&apos;s own)</option>
              <option value="demo">This sandbox&apos;s demo patients</option>
            </select>
          </div>
          {optumSource === 'sandbox' ? (
            <div className="flex-1 min-w-56">
              <label className="text-xs text-gray-400 block mb-1">Optum sandbox member</label>
              <select
                value={optumSandboxMemberId}
                onChange={(e) => setOptumSandboxMemberId(e.target.value)}
                className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-violet-500"
              >
                {OPTUM_SANDBOX_MEMBER_LIST.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
          ) : (
            <div className="flex-1 min-w-56">
              <label className="text-xs text-gray-400 block mb-1">Demo patient to submit</label>
              <select
                value={optumPatientId}
                onChange={(e) => setOptumPatientId(e.target.value)}
                className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-violet-500"
              >
                {PATIENT_LIST.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} — {p.planName} (subscriber {p.subscriberId})</option>
                ))}
              </select>
            </div>
          )}
          <button
            onClick={checkOptum}
            disabled={optumLoading}
            className="bg-violet-700 hover:bg-violet-600 disabled:opacity-50 text-white text-sm font-semibold px-4 py-1.5 rounded"
          >
            {optumLoading ? 'Querying Optum…' : 'Run $bulk-member-match'}
          </button>
        </div>

        {optumResult && (
          <div className="mt-3">
            {optumResult.ok ? (
              <>
                <div className="text-xs text-violet-300 mb-2">
                  {sandboxResponseLabel('Optum', optumResult.json.mode)}
                  {optumResult.json.subject && (
                    <span className="ml-2">
                      submitted: <span className="font-semibold text-violet-200">{optumResult.json.subject.name}</span>
                      <span className="ml-1 text-violet-400">({optumResult.json.source})</span>
                    </span>
                  )}
                </div>
                {(() => {
                  const params = optumResult.json?.response?.parameter || [];
                  const groups = ['MatchedMembers', 'NonMatchedMembers', 'ConsentConstrainedMembers'];
                  const source = optumResult.json?.source;
                  const subjName = optumResult.json?.subject?.name || '';
                  const subjIdent = optumResult.json?.subject?.identifier || '';
                  // Match by contained Patient identifier/name. Sandbox
                  // members carry an EMR-XXXXX identifier that Optum
                  // echoes verbatim in the response; demo patients carry
                  // a BCBSIL subscriber id that Optum's roster does not
                  // know, so no group's contained patients will match.
                  const groupInfo = groups.map((name) => {
                    const group = params.find((p) => p.name === name);
                    const contained = group?.resource?.contained || [];
                    const members = group?.resource?.member || [];
                    const containsOurSubject = contained.some((c) => {
                      const ids = (c?.identifier || []).map((i) => i?.value || '').join(' ');
                      const nm = (c?.name?.[0]?.given || []).join(' ') + ' ' + (c?.name?.[0]?.family || '');
                      return (
                        (subjIdent && ids.includes(subjIdent)) ||
                        (subjName && nm.trim().toLowerCase() === subjName.trim().toLowerCase())
                      );
                    });
                    return { name, contained, members, containsOurSubject };
                  });
                  const anyMatchFound = groupInfo.some((g) => g.containsOurSubject);
                  return (
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        {groupInfo.map(({ name, contained, members, containsOurSubject }) => (
                          <div
                            key={name}
                            className={`bg-gray-900 rounded border p-2 ${containsOurSubject ? 'border-emerald-500 ring-1 ring-emerald-500/50' : 'border-gray-700'}`}
                          >
                            <div className="text-xs font-semibold text-violet-300 mb-1">{name}</div>
                            <div className="text-xs text-gray-400">
                              {contained.length} contained · {members.length} member{members.length !== 1 ? 's' : ''}
                            </div>
                            {contained.length > 0 && (
                              <div className="text-[11px] text-gray-500 mt-1 space-y-0.5">
                                {contained.slice(0, 3).map((c) => (
                                  <div key={c.id} className="truncate">
                                    {(c?.name?.[0]?.given || []).join(' ')} {c?.name?.[0]?.family} — <span className="font-mono">{c?.identifier?.[0]?.value}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {containsOurSubject && (
                              <div className="text-xs text-emerald-400 mt-1">Our subject appears here</div>
                            )}
                          </div>
                        ))}
                      </div>
                      {!anyMatchFound && (
                        <div className="text-xs text-gray-500 mt-2">
                          {source === 'demo' ? (
                            <>{subjName} does not appear in any of Optum&apos;s returned groups — their sandbox roster is unrelated to this sandbox&apos;s demo patients. That is the honest outcome, effectively a real <span className="font-mono">NonMatchedMembers</span> verdict for this patient.</>
                          ) : (
                            <>Submitted subject not found in the response&apos;s contained patients — try the other sandbox member.</>
                          )}
                        </div>
                      )}
                    </>
                  );
                })()}
                <details className="mt-2">
                  <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300">Show request/response JSON</summary>
                  <pre className="text-xs text-gray-400 bg-gray-950 rounded p-2 mt-1 overflow-x-auto max-h-64">
                    {JSON.stringify(optumResult.json, null, 2)}
                  </pre>
                </details>

                {/* Three-step $davinci-data-export chain, gated on a
                    successful member-match so the groupId default flows
                    from step 0 into step 1. Same story continues: match
                    members -> bulk-export the matched group. */}
                {matchedGroupId && (
                  <div className="mt-4 bg-violet-950/50 border border-violet-700 rounded p-3">
                    <div className="text-xs uppercase tracking-widest text-violet-400 mb-2">
                      Bulk export chain ($davinci-data-export)
                    </div>
                    <p className="text-[11px] text-gray-400 mb-3">
                      Da Vinci PDex async export: kick off for a matched group → poll for a manifest of NDJSON files → download one file&apos;s contents. Live behavior against Optum&apos;s sandbox is unverified from this session; mock mode replays the OAS example verbatim so the flow runs with zero credentials.
                    </p>

                    {/* Step 1 -- kickoff */}
                    <div className="mb-3">
                      <div className="text-xs text-violet-300 font-semibold mb-1">Step 1 — kickoff</div>
                      <div className="flex gap-2 items-end flex-wrap">
                        <div className="flex-1 min-w-56">
                          <label className="text-[11px] text-gray-500 block mb-0.5">groupId</label>
                          <input
                            type="text"
                            value={exportGroupId}
                            onChange={(e) => setExportGroupId(e.target.value)}
                            className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 font-mono"
                          />
                        </div>
                        <button
                          onClick={runKickoff}
                          disabled={exportBusy === 'kickoff'}
                          className="bg-violet-700 hover:bg-violet-600 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1 rounded"
                        >
                          {exportBusy === 'kickoff' ? 'Kicking off…' : 'POST $davinci-data-export'}
                        </button>
                        {matchedGroupId && matchedGroupId !== exportGroupId && (
                          <button
                            onClick={() => setExportGroupId(matchedGroupId)}
                            className="text-[11px] text-violet-400 underline"
                          >
                            use matched group id
                          </button>
                        )}
                      </div>
                      {exportKickoff && (
                        <div className="text-[11px] text-gray-400 mt-1">
                          {exportKickoff.ok ? (
                            <>
                              HTTP {exportKickoff.json.status || exportKickoff.status} · {sandboxResponseLabel('Optum', exportKickoff.json.mode)} · jobId <span className="font-mono text-violet-300">{exportKickoff.json.jobId || '(none)'}</span> · Content-Location <span className="font-mono text-violet-300 truncate inline-block max-w-md align-bottom">{exportKickoff.json.contentLocation || '(none)'}</span>
                            </>
                          ) : (
                            <span className="text-red-400">Error: {exportKickoff.json?.error || `HTTP ${exportKickoff.status}`}</span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Step 2 -- status */}
                    <div className="mb-3">
                      <div className="text-xs text-violet-300 font-semibold mb-1">Step 2 — poll status</div>
                      <button
                        onClick={runStatusPoll}
                        disabled={!exportKickoff?.json?.jobId || exportBusy === 'status'}
                        className="bg-violet-700 hover:bg-violet-600 disabled:opacity-40 text-white text-xs font-semibold px-3 py-1 rounded"
                      >
                        {exportBusy === 'status' ? 'Polling…' : 'GET $bulk-member-match-status'}
                      </button>
                      {exportManifest && (
                        <div className="text-[11px] text-gray-400 mt-1">
                          {exportManifest.ok ? (
                            <>
                              HTTP {exportManifest.json.status || exportManifest.status} · {sandboxResponseLabel('Optum', exportManifest.json.mode)} · {exportManifest.json.response?.output?.length || 0} output file(s) · {exportManifest.json.response?.error?.length || 0} error file(s)
                            </>
                          ) : (
                            <span className="text-red-400">Error: {exportManifest.json?.error || `HTTP ${exportManifest.status}`}</span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Step 3 -- download */}
                    <div>
                      <div className="text-xs text-violet-300 font-semibold mb-1">Step 3 — download NDJSON</div>
                      {(exportManifest?.json?.response?.output || []).length === 0 ? (
                        <div className="text-[11px] text-gray-500">Poll the manifest first.</div>
                      ) : (
                        <div className="space-y-1">
                          {exportManifest.json.response.output.map((f) => (
                            <button
                              key={f.url}
                              onClick={() => runDownload(f.url)}
                              disabled={exportBusy === 'download'}
                              className="block bg-violet-800/60 hover:bg-violet-700 disabled:opacity-40 text-violet-100 text-[11px] font-mono px-2 py-1 rounded text-left"
                            >
                              {f.type} — {f.url}
                            </button>
                          ))}
                        </div>
                      )}
                      {exportDownload && (
                        <div className="mt-2">
                          {exportDownload.ok ? (
                            <>
                              <div className="text-[11px] text-gray-400">
                                {sandboxResponseLabel('Optum', exportDownload.json.mode)} · {exportDownload.json.resources?.length || 0} resource(s) parsed
                              </div>
                              <div className="mt-1 space-y-0.5">
                                {(exportDownload.json.resources || []).slice(0, 5).map((r, i) => (
                                  <div key={i} className="text-[11px] text-emerald-300 font-mono truncate">
                                    {r.resourceType} · {(r.name?.[0]?.given || []).join(' ')} {Array.isArray(r.name?.[0]?.family) ? r.name?.[0]?.family?.join(' ') : r.name?.[0]?.family} · {r.gender} · {r.birthDate}
                                  </div>
                                ))}
                              </div>
                              <details className="mt-1">
                                <summary className="text-[11px] text-gray-500 cursor-pointer hover:text-gray-300">Show raw NDJSON</summary>
                                <pre className="text-[11px] text-gray-400 bg-gray-950 rounded p-2 mt-1 overflow-x-auto max-h-48">{exportDownload.json.rawNdjson}</pre>
                              </details>
                            </>
                          ) : (
                            <div className="text-xs text-red-400">Error: {exportDownload.json?.error || `HTTP ${exportDownload.status}`}</div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="text-sm text-red-400">
                Error: {optumResult.json?.error || `HTTP ${optumResult.status}`}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Results */}
      {isLoading && (
        <div className="text-sm text-gray-400">Querying attributed panel…</div>
      )}

      {data && !isLoading && (
        <>
          <div className="text-xs text-gray-500">
            NPI <code className="text-gray-300">{data.npi}</code> — {data.patients.length} attributed patient{data.patients.length !== 1 ? 's' : ''} with activity in the live log
          </div>

          {data.patients.length === 0 && (
            <div className="text-sm text-amber-400 bg-amber-950/40 border border-amber-700 rounded p-3">
              No attributed patients found. Run a CRD hook from the EHR surface first to generate log entries.
            </div>
          )}

          <div className="space-y-2">
            {data.patients.map((p) => (
              <div key={p.patientId} className="bg-gray-800 border border-gray-700 rounded">
                <button
                  className="w-full text-left p-3 flex items-center justify-between gap-4"
                  onClick={() => setExpandedPatient(expandedPatient === p.patientId ? null : p.patientId)}
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold text-gray-100">{p.patientName}</span>
                    <span className="text-xs text-gray-400">{p.patientId}</span>
                    <span className="text-xs bg-blue-900 text-blue-200 px-2 py-0.5 rounded">{p.planType}</span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-xs text-gray-500">{p.eventCount} event{p.eventCount !== 1 ? 's' : ''}</span>
                    <span className="text-xs text-gray-500">
                      {p.lastActivity ? new Date(p.lastActivity).toLocaleString() : '—'}
                    </span>
                    <span className="text-gray-500 text-xs">{expandedPatient === p.patientId ? '▲' : '▼'}</span>
                  </div>
                </button>

                {expandedPatient === p.patientId && (
                  <div className="border-t border-gray-700 p-3 space-y-1.5">
                    <DrugPriorAuths eobs={p.priorAuthorizations} />
                    <div className="text-xs text-gray-400 uppercase tracking-wide mb-2">Activity log</div>
                    {p.events.map((ev, i) => (
                      <div key={i} className="text-xs flex gap-2">
                        <span className="text-gray-500 shrink-0">{new Date(ev.timestamp).toLocaleTimeString()}</span>
                        <span className="text-blue-400 shrink-0">[{ev.actor}]</span>
                        <span className={`shrink-0 font-semibold ${actionColor(ev.action)}`}>{ev.action}:</span>
                        <span className="text-gray-300 truncate">{ev.details}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SmartAuthBanner() {
  const [tokenClaims, setTokenClaims] = useState(null);
  const [unauthResult, setUnauthResult] = useState(null);

  const showToken = async () => {
    try {
      const t = await getDemoToken(SYSTEM_SCOPES);
      setTokenClaims(decodeJwtPayload(t.access_token));
    } catch {
      setTokenClaims(null);
    }
  };

  // The 401 demo beat: call the API with no Authorization header and show
  // the OperationOutcome the server returns.
  const tryWithoutToken = async () => {
    const res = await fetch(apiUrl('/api/provider-access?npi=1234567890'));
    const body = await res.json().catch(() => null);
    setUnauthResult({
      status: res.status,
      diagnostics: body?.issue?.[0]?.diagnostics || JSON.stringify(body)
    });
  };

  return (
    <div className="bg-indigo-950/50 border border-indigo-700 rounded p-3 text-xs text-indigo-200">
      <span className="font-bold text-indigo-300">SMART on FHIR v2 — backend-services flow (demo token endpoint)</span>
      <span className="text-indigo-400 ml-2">
        This panel exchanges client credentials at{' '}
        <code className="bg-indigo-900 px-1 rounded">/api/auth/token</code> for a five minute JWT
        and queries with it. Without a Bearer token the API returns 401. Production backend
        services would present a signed client assertion per SMART v2 rather than a shared demo secret.
      </span>
      <div className="mt-2 flex flex-wrap gap-2 items-center">
        <button
          type="button"
          onClick={showToken}
          className="bg-indigo-800 hover:bg-indigo-700 text-indigo-100 px-2 py-0.5 rounded border border-indigo-600"
        >
          Fetch token and show claims
        </button>
        <button
          type="button"
          onClick={tryWithoutToken}
          className="bg-slate-800 hover:bg-slate-700 text-slate-200 px-2 py-0.5 rounded border border-slate-600"
        >
          Try the API without a token
        </button>
      </div>
      {tokenClaims && (
        <div className="mt-2 font-mono text-[11px] text-indigo-100 bg-indigo-900/60 border border-indigo-700 rounded px-2 py-1 break-all">
          sub={tokenClaims.sub} · exp {new Date(tokenClaims.exp * 1000).toLocaleTimeString()} · scope={tokenClaims.scope}
        </div>
      )}
      {unauthResult && (
        <div className="mt-2 font-mono text-[11px] text-red-200 bg-red-950/60 border border-red-800 rounded px-2 py-1">
          HTTP {unauthResult.status} — {unauthResult.diagnostics}
        </div>
      )}
    </div>
  );
}

function actionColor(action) {
  if (/EVALUATION|HOOK/i.test(action)) return 'text-yellow-400';
  if (/X12 278/i.test(action)) return 'text-cyan-300';
  if (/COVERAGE-INFORMATION/i.test(action)) return 'text-fuchsia-400';
  if (/APPROVED/i.test(action)) return 'text-green-400';
  if (/DENIED|DENIAL/i.test(action)) return 'text-red-400';
  return 'text-gray-300';
}
