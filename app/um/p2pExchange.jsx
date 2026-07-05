'use client';
import { useState } from 'react';
import { apiUrl } from '@/lib/basePath';
import { PATIENT_LIST, PAYER_NAME, PRIOR_PLAN_HISTORY } from '@/lib/patients';

function buildMemberMatchRequest(patient) {
  return {
    resourceType: 'Parameters',
    parameter: [
      {
        name: 'MemberPatient',
        resource: {
          resourceType: 'Patient',
          id: patient.id,
          name: [{ text: patient.name }],
          birthDate: patient.dob,
          identifier: [{ system: 'urn:payer:bcbsil:member', value: patient.subscriberId }],
        },
      },
      {
        name: 'CoverageToMatch',
        resource: {
          resourceType: 'Coverage',
          status: 'active',
          subscriberId: patient.subscriberId,
          payor: [{ display: PAYER_NAME }],
          period: { start: '2026-01-01', end: '2026-12-31' },
        },
      },
    ],
  };
}

export default function P2PExchangePanel() {
  const [patientId, setPatientId] = useState('pat-8849-jane-doe');
  const [step, setStep] = useState('idle'); // idle | matching | matched | fetching | done | error
  const [matchRequest, setMatchRequest] = useState(null);
  const [matchResponse, setMatchResponse] = useState(null);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);

  const patient = PATIENT_LIST.find((p) => p.id === patientId);

  const reset = () => {
    setStep('idle');
    setMatchRequest(null);
    setMatchResponse(null);
    setHistory(null);
    setError(null);
  };

  const runExchange = async () => {
    reset();
    setStep('matching');

    const req = buildMemberMatchRequest(patient);
    setMatchRequest(req);

    try {
      const res = await fetch(apiUrl('/api/payer-to-payer/member-match'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      });
      const matchData = await res.json();
      setMatchResponse(matchData);

      // The matched member identifier comes back inside the Parameters
      // resource, exactly as a production caller would read it.
      const memberIdentifier = matchData?.parameter?.find(
        (p) => p.name === 'MemberIdentifier'
      )?.valueIdentifier?.value;

      if (!res.ok || !memberIdentifier) {
        setStep('error');
        setError(matchData?.issue?.[0]?.diagnostics || 'Member match failed');
        return;
      }

      setStep('fetching');
      const histRes = await fetch(apiUrl(`/api/payer-to-payer/history/${memberIdentifier}`));
      const histData = await histRes.json();
      if (!histRes.ok) {
        setStep('error');
        setError(histData?.issue?.[0]?.diagnostics || `History fetch failed (HTTP ${histRes.status})`);
        return;
      }
      setHistory(histData);
      setStep('done');
    } catch (e) {
      setStep('error');
      setError(String(e.message || e));
    }
  };

  // Prior payer for display subtitles — client-side seed data, matching what
  // the prior payer identifies itself as in the Parameters system URI.
  const priorPayer = PRIOR_PLAN_HISTORY[patientId]?.priorPayer || 'Prior Payer';

  return (
    <div className="flex flex-col gap-4">
      {/* Regulation banner */}
      <div className="bg-indigo-950/50 border border-indigo-700 rounded p-3 text-xs text-indigo-200">
        <span className="font-bold text-indigo-300">45 CFR 156.221(c) — Payer-to-Payer API (effective Jan 1, 2027)</span>
        <span className="text-indigo-400 ml-2">
          New payer sends <code className="bg-indigo-900 px-1 rounded">POST /Patient/$member-match</code> to prior payer. Prior payer returns a matched member ID.
          New payer then requests bulk FHIR export of PA history and clinical data (up to 5 years lookback).
          Member consent required. Demo: consent captured via enrollment form.
        </span>
      </div>

      {/* Patient selector + trigger */}
      <div className="bg-gray-800 rounded border border-gray-700 p-4">
        <div className="text-sm font-bold text-blue-300 mb-3">Simulate enrollment — request prior plan data</div>
        <div className="flex gap-2 flex-wrap items-end">
          <div className="flex-1 min-w-48">
            <label className="text-xs text-gray-400 block mb-1">Newly enrolled member</label>
            <select
              value={patientId}
              onChange={(e) => { setPatientId(e.target.value); reset(); }}
              className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
            >
              {PATIENT_LIST.map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p.subscriberId})</option>
              ))}
            </select>
          </div>
          <button
            onClick={runExchange}
            disabled={step === 'matching' || step === 'fetching'}
            className="bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white text-sm font-semibold px-4 py-1.5 rounded"
          >
            {step === 'matching' ? 'Sending $member-match…' : step === 'fetching' ? 'Fetching history…' : 'Request prior plan data'}
          </button>
          {step !== 'idle' && (
            <button onClick={reset} className="text-xs text-gray-400 hover:text-gray-200 underline">Reset</button>
          )}
        </div>
      </div>

      {/* Step 1: $member-match request */}
      {matchRequest && (
        <ExchangeStep
          title="Step 1 — $member-match request"
          subtitle={`BCBSIL → ${priorPayer}: POST /Patient/$member-match`}
          color="purple"
          badge="SENT"
        >
          <JsonBlock data={matchRequest} />
        </ExchangeStep>
      )}

      {/* Step 2: $member-match response */}
      {matchResponse && (
        <ExchangeStep
          title="Step 2 — $member-match response"
          subtitle={`${priorPayer} → BCBSIL: MemberIdentifier returned in the Parameters resource`}
          color={step === 'error' ? 'red' : 'green'}
          badge={step === 'error' ? 'ERROR' : 'MATCHED'}
        >
          {error ? (
            <div className="text-red-300 text-xs">{error}</div>
          ) : (
            <JsonBlock data={matchResponse} />
          )}
        </ExchangeStep>
      )}

      {/* Step 3: clinical history (FHIR searchset Bundle) */}
      {history && <HistoryStep bundle={history} />}
    </div>
  );
}

// Renders the prior-plan history Bundle by walking its entries: one prior
// Coverage, ClaimResponses for the prior PAs, and CARIN BB EOBs.
function HistoryStep({ bundle }) {
  const resources = (bundle.entry || []).map((e) => e.resource).filter(Boolean);
  const coverage = resources.find((r) => r.resourceType === 'Coverage');
  const priorPas = resources.filter((r) => r.resourceType === 'ClaimResponse');
  const eobs = resources.filter((r) => r.resourceType === 'ExplanationOfBenefit');

  const planClass = coverage?.class?.[0];
  const totalBy = (eob, code) =>
    (eob.total || []).find((t) => t.category?.coding?.some((c) => c.code === code))
      ?.amount?.value;

  return (
    <ExchangeStep
      title="Step 3 — Prior plan clinical history"
      subtitle={`${planClass?.name || 'Prior plan'} · Disenrolled ${coverage?.period?.end || '—'} · Bundle(${bundle.type}) with ${bundle.total ?? resources.length} resources`}
      color="cyan"
      badge="RECEIVED"
    >
      <div className="space-y-3">
        <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">
          Prior authorizations (ClaimResponse, use=preauthorization)
        </div>
        {priorPas.map((cr) => {
          const approved = cr.outcome === 'complete';
          const serviceCoding = cr.addItem?.[0]?.productOrService?.coding?.[0];
          const denial = cr.error?.[0]?.code;
          return (
            <div
              key={cr.id}
              className={`rounded border p-3 text-xs ${approved ? 'bg-green-950/30 border-green-700' : 'bg-red-950/30 border-red-700'}`}
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="font-bold text-gray-100">{cr.disposition}</span>
                <span className={`px-2 py-0.5 rounded font-semibold ${approved ? 'bg-green-800 text-green-200' : 'bg-red-800 text-red-200'}`}>
                  {approved ? 'APPROVED' : 'DENIED'}
                </span>
              </div>
              <div className="text-gray-400">
                Auth # <code className="text-gray-200">{cr.preAuthRef}</code>
                {serviceCoding && (
                  <>
                    {' · '}CPT/HCPCS <code className="text-gray-200">{serviceCoding.code}</code>
                  </>
                )}
                {' · '}Decided {cr.created?.slice(0, 10)}
                {cr.preAuthPeriod?.end && <> {' · '}Valid through {cr.preAuthPeriod.end}</>}
              </div>
              {denial && (
                <div className="text-red-300 mt-1">
                  Denial: {denial.text}
                  {denial.coding?.[0]?.code && (
                    <code className="ml-1 bg-red-900 px-1 rounded">{denial.coding[0].code}</code>
                  )}
                </div>
              )}
              {(cr.processNote || []).map((n) => (
                <div key={n.number} className={`mt-1 ${/appeal/i.test(n.text) ? 'text-amber-300' : 'text-green-300'}`}>
                  {n.text}
                </div>
              ))}
            </div>
          );
        })}

        <div className="text-xs uppercase tracking-wide text-gray-400 mt-3 mb-1">
          Claims (ExplanationOfBenefit, CARIN BB)
        </div>
        <table className="text-xs w-full">
          <thead>
            <tr className="text-gray-500">
              <th className="text-left py-1 pr-3">Date</th>
              <th className="text-left py-1 pr-3">Service</th>
              <th className="text-right py-1 pr-3">Billed</th>
              <th className="text-right py-1 pr-3">Plan paid</th>
              <th className="text-right py-1">Member OOP</th>
            </tr>
          </thead>
          <tbody>
            {eobs.map((eob) => (
              <tr key={eob.id} className="border-t border-gray-700">
                <td className="py-1 pr-3 text-gray-400">{eob.item?.[0]?.servicedDate}</td>
                <td className="py-1 pr-3 text-gray-200">{eob.item?.[0]?.productOrService?.text}</td>
                <td className="py-1 pr-3 text-right text-gray-200">${totalBy(eob, 'submitted')?.toLocaleString()}</td>
                <td className="py-1 pr-3 text-right text-green-300">${totalBy(eob, 'paidtoprovider')?.toLocaleString()}</td>
                <td className="py-1 text-right text-amber-300">${totalBy(eob, 'memberliability')?.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="text-[11px] text-gray-500 mt-2 italic">
          Production transport would be bulk FHIR (NDJSON) via $export on the Group
          returned after $member-match. The raw Bundle below is what this demo
          endpoint returns.
        </div>
        <JsonBlock data={bundle} />
      </div>
    </ExchangeStep>
  );
}

function ExchangeStep({ title, subtitle, color, badge, children }) {
  const colors = {
    purple: { border: 'border-purple-700', heading: 'text-purple-300', badge: 'bg-purple-800 text-purple-200' },
    green:  { border: 'border-green-700',  heading: 'text-green-300',  badge: 'bg-green-800 text-green-200'  },
    cyan:   { border: 'border-cyan-700',   heading: 'text-cyan-300',   badge: 'bg-cyan-800 text-cyan-200'    },
    red:    { border: 'border-red-700',    heading: 'text-red-300',    badge: 'bg-red-800 text-red-200'      },
  };
  const c = colors[color] || colors.purple;

  return (
    <div className={`bg-gray-800 rounded border ${c.border} p-4`}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className={`text-sm font-bold ${c.heading}`}>{title}</div>
          <div className="text-xs text-gray-400 mt-0.5">{subtitle}</div>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded font-semibold shrink-0 ${c.badge}`}>{badge}</span>
      </div>
      {children}
    </div>
  );
}

function JsonBlock({ data }) {
  const [collapsed, setCollapsed] = useState(true);
  const text = JSON.stringify(data, null, 2);
  const lines = text.split('\n');
  const preview = lines.slice(0, 8).join('\n');

  return (
    <div className="bg-gray-900 rounded border border-gray-700 p-3 text-xs font-mono">
      <pre className="text-gray-300 whitespace-pre-wrap overflow-auto" style={{ maxHeight: collapsed ? '10rem' : '30rem' }}>
        {collapsed && lines.length > 8 ? preview + '\n…' : text}
      </pre>
      {lines.length > 8 && (
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="mt-2 text-[11px] text-blue-400 hover:text-blue-300 underline"
        >
          {collapsed ? `Expand (${lines.length} lines)` : 'Collapse'}
        </button>
      )}
    </div>
  );
}
