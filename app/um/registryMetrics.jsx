'use client';
import useSWR from 'swr';
import { apiUrl } from '@/lib/basePath';
import { authedFetch } from '@/lib/smartClient';

/**
 * Registry and metrics (CMS-0062-P position 4): the endpoint report, API
 * usage with third-party success and error rates, and PA metrics as counts
 * plus percentages. Also lets the viewer send a call with a bad token, to
 * watch the error rate move.
 */
const fetcher = (url) => fetch(url).then((r) => {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
});

function Stat({ label, value, sub }) {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded p-2">
      <div className="text-[10px] uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-lg text-gray-100">{value ?? '-'}</div>
      {sub && <div className="text-[10px] text-gray-500">{sub}</div>}
    </div>
  );
}

function PaBlock({ title, m }) {
  if (!m) return null;
  return (
    <div className="mb-3">
      <div className="text-xs text-gray-300 font-bold mb-1">{title}</div>
      <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-9 gap-2">
        <Stat label="Requests" value={m.requests} />
        <Stat label="Approved" value={m.approved} sub={`${m.approvedPct}%`} />
        <Stat label="Denied" value={m.denied} sub={`${m.deniedPct}%`} />
        <Stat label="Pending" value={m.pending} />
        <Stat label="Appeals" value={m.appeals} />
        <Stat label="Overturned" value={m.overturned} />
        <Stat label="Denied after appeal" value={m.deniedAfterAppeal} />
        <Stat label="Avg decision" value={m.avgDecisionSeconds != null ? `${m.avgDecisionSeconds}s` : '-'} />
        <Stat label="Median decision" value={m.medianDecisionSeconds != null ? `${m.medianDecisionSeconds}s` : '-'} />
      </div>
    </div>
  );
}

export default function RegistryMetricsPanel() {
  const { data: registry } = useSWR(apiUrl('/api/registry/endpoints'), fetcher);
  const { data: metrics, mutate } = useSWR(apiUrl('/api/metrics'), fetcher, { refreshInterval: 3000 });

  // Deliberately sends a malformed token so the Patient Access error rate
  // rises. A call with no token at all is counted apart (the demo's
  // 401 → token → 200 step) and does not move the rate.
  const sendBadToken = async () => {
    await fetch(apiUrl('/api/patient-access?patientId=pat-8849-jane-doe'), {
      headers: { authorization: 'Bearer not-a-valid-token' }
    }).catch(() => {});
    mutate();
  };
  const sendGoodCall = async () => {
    await authedFetch(apiUrl('/api/patient-access?patientId=pat-8849-jane-doe'), [
      'patient/Patient.read',
      'patient/Coverage.read',
      'patient/ExplanationOfBenefit.read',
      'patient/ClaimResponse.read'
    ]).catch(() => {});
    mutate();
  };

  const pa = metrics?.priorAuthorization;
  const endpoints = (registry?.entry || []).map((e) => e.resource);

  return (
    <div className="space-y-6 text-sm">
      <div className="text-xs text-amber-200 bg-amber-950/30 border border-amber-800 rounded px-3 py-2">
        CMS-0062-P is a proposed rule. The reporting below follows its proposals. Counts are in-memory and reset with the demo.
      </div>

      <section>
        <h3 className="text-gray-300 font-bold mb-1">Endpoint report</h3>
        <p className="text-xs text-gray-500 mb-2">
          Base FHIR <code>Endpoint</code> resources, the rule&rsquo;s primary proposal. The NDH Endpoint profile is the alternative CMS asked about, so these do not claim it. Served at <code>/api/registry/endpoints</code>.
        </p>
        <table className="w-full text-xs border border-gray-700">
          <thead className="bg-gray-800 text-gray-400">
            <tr>
              <th className="text-left px-2 py-1 font-normal">API</th>
              <th className="text-left px-2 py-1 font-normal">Address</th>
              <th className="text-left px-2 py-1 font-normal">Payload</th>
            </tr>
          </thead>
          <tbody>
            {endpoints.map((ep) => (
              <tr key={ep.id} className="border-t border-gray-800">
                <td className="px-2 py-1 text-gray-200">{ep.name}</td>
                <td className="px-2 py-1 text-cyan-300 break-all">{ep.address}</td>
                <td className="px-2 py-1 text-gray-400">{ep.payloadType?.[0]?.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h3 className="text-gray-300 font-bold mb-1">API usage</h3>
        <p className="text-xs text-gray-500 mb-2">
          Error rate = auth failures (a bad or expired token, or missing scopes) plus server errors, over those plus successes. A 401 with no token is the demo&rsquo;s scripted first step and is counted apart.
        </p>
        <div className="flex gap-2 mb-2">
          <button onClick={sendBadToken} className="bg-red-800 hover:bg-red-700 text-white text-xs px-3 py-1 rounded">
            Send a call with a bad token
          </button>
          <button onClick={sendGoodCall} className="bg-green-800 hover:bg-green-700 text-white text-xs px-3 py-1 rounded">
            Send a valid call
          </button>
        </div>
        <table className="w-full text-xs border border-gray-700">
          <thead className="bg-gray-800 text-gray-400">
            <tr>
              {['API', 'Calls', 'Success', 'No token (demo step)', 'Auth failure', 'Client error', 'Server error', 'Error rate'].map((h) => (
                <th key={h} className="text-left px-2 py-1 font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(metrics?.usage || []).map((u) => (
              <tr key={u.api} className="border-t border-gray-800 text-gray-300">
                <td className="px-2 py-1 text-gray-200">{u.api}</td>
                <td className="px-2 py-1">{u.total}</td>
                <td className="px-2 py-1">{u.success}</td>
                <td className="px-2 py-1">{u.unauthenticated}</td>
                <td className="px-2 py-1">{u.authFailure}</td>
                <td className="px-2 py-1">{u.clientError}</td>
                <td className="px-2 py-1">{u.serverError}</td>
                <td className="px-2 py-1 font-bold">{u.errorRatePct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {pa && (
        <section>
          <h3 className="text-gray-300 font-bold mb-2">Prior authorization metrics</h3>
          <PaBlock title="Medical items and services" m={pa.medicalItems} />
          <PaBlock title="Drugs, all" m={pa.drugs.all} />
          <PaBlock title="Drugs, medical benefit" m={pa.drugs.medicalBenefit} />
          <PaBlock title="Drugs, pharmacy benefit" m={pa.drugs.pharmacyBenefit} />
          {pa.drugs.byPlan.map((p) => (
            <PaBlock key={p.planType} title={`Drugs, ${p.planType}${p.note ? ` (${p.note})` : ''}`} m={p} />
          ))}
          <div className="text-xs text-gray-400 mt-2">
            Drugs requiring PA: {pa.drugsRequiringPa.gridJCodeRules} J-code rules on the ingested grids (
            {Object.entries(pa.drugsRequiringPa.gridJCodeRulesBySource).map(([k, v]) => `${k} ${v}`).join(', ')}
            ), plus the sandbox catalog: {pa.drugsRequiringPa.catalog.map((d) => d.name).join(', ')}.
          </div>
          <ul className="text-xs text-gray-500 mt-2 list-disc pl-5">
            {pa.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}
