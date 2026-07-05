'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { apiUrl } from '@/lib/basePath';
import { authedFetch, getDemoToken, decodeJwtPayload } from '@/lib/smartClient';

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
