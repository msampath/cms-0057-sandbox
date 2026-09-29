'use client';
import { useEffect, useRef, useState } from 'react';
import { apiUrl } from '@/lib/basePath';
import { DRUG_CATALOG } from '@/lib/drugPa';
import ClockBadge from '@/app/components/ClockBadge';

/**
 * Pharmacy-benefit drug track: RTPB → F&B → NCPDP SCRIPT ePA, routed to
 * the PBM. The question set and the decision come from the same shared
 * model (lib/drugPa.js) the medical PAS track uses, and answers already
 * given on the medical track are carried over from the shared record.
 */
export default function PharmacyEpa({ drugKey, patientId, prescriberNpi, planType, expedited = false }) {
  const drug = DRUG_CATALOG[drugKey];
  const [benefit, setBenefit] = useState(null);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [applyException, setApplyException] = useState(false);
  // Guards the submit handler's state writes after an unmount (scenario or
  // order switched while PARequest was in flight).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let live = true;
    fetch(apiUrl('/api/drug-pa/pharmacy'), {
      method: 'POST',
      body: JSON.stringify({ step: 'benefit', drugKey, patientId, prescriberNpi, planType, expedited })
    })
      .then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json().catch(() => ({})) }))
      .then(({ ok, status, json }) => {
        if (!live) return;
        if (!ok || json.error) throw new Error(json.error || json.issue?.[0]?.diagnostics || `HTTP ${status}`);
        setBenefit(json);
        setAnswers(json.prefill || {});
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [drugKey, patientId, prescriberNpi, planType, expedited]);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/drug-pa/pharmacy'), {
        method: 'POST',
        body: JSON.stringify({
          step: 'submit',
          drugKey,
          patientId,
          prescriberNpi,
          planType,
          expedited,
          applyException,
          caseId: benefit.caseId,
          answers
        })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) throw new Error(json.error || json.issue?.[0]?.diagnostics || `HTTP ${res.status}`);
      if (mounted.current) setResult(json);
    } catch (err) {
      if (mounted.current) setError(err.message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  };

  return (
    <div className="bg-teal-50 border-2 border-teal-600 text-teal-950 px-6 py-4 rounded-lg shadow-sm mb-6 max-w-3xl">
      <div className="text-xs uppercase tracking-widest text-teal-700 mb-1">
        Pharmacy benefit · NCPDP · routed to {benefit?.pbm || 'PBM'}
      </div>
      <div className="font-bold text-lg mb-2">
        {drug.name}, {drug.siteOfCare.self.label}
      </div>
      <div className="text-xs text-teal-800 mb-3">
        NDC <code className="bg-white px-1 rounded">{drug.siteOfCare.self.ndc}</code> · RxNorm{' '}
        <code className="bg-white px-1 rounded">{drug.siteOfCare.self.rxcui}</code>. Self-administered, so CRD and PAS do not apply.
        The grid&rsquo;s J0717 medical rule excludes self-administration.
      </div>

      {loading && !benefit && <div className="text-sm">Checking real-time prescription benefit...</div>}
      {error && <div className="text-sm text-red-700">Error: {error}</div>}

      {benefit && (
        <>
          <div className="grid md:grid-cols-2 gap-2 text-sm mb-3">
            <div className="bg-white rounded border border-teal-200 p-2">
              <div className="text-[10px] uppercase tracking-widest text-teal-700">RTPB v13</div>
              {benefit.rtpb.coverageStatus} · PA required: {benefit.rtpb.priorAuthorizationRequired ? 'yes' : 'no'}
            </div>
            <div className="bg-white rounded border border-teal-200 p-2">
              <div className="text-[10px] uppercase tracking-widest text-teal-700">F&amp;B v60 formulary</div>
              {benefit.formulary.formularyStatus} · {benefit.formulary.coverageFactors.join(', ')}
            </div>
          </div>

          {!result && <ClockBadge clock={benefit.clock} />}

          {benefit.exception && (
            <div className="text-xs bg-amber-50 border border-amber-300 text-amber-900 rounded px-2 py-1 mb-2">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={applyException}
                  onChange={(e) => setApplyException(e.target.checked)}
                />
                <span>
                  Apply the FFE issuer exception from the NCPDP requirement, ending{' '}
                  {benefit.exception.until}
                </span>
              </label>
              {applyException && (
                <div className="mt-1">
                  With the exception, the NCPDP ePA requirement would not apply to this issuer until {benefit.exception.until}. The decision clock still applies. The end date models the position that the exception should be narrow and time-limited. It is not rule text: the proposed rule makes the exception a justification and compliance-plan process.
                </div>
              )}
            </div>
          )}

          {benefit.prefillFrom === 'medical' && (
            <div className="text-xs bg-emerald-100 border border-emerald-300 text-emerald-900 rounded px-2 py-1 mb-2">
              Answers carried over from the medical-benefit (DTR) request on the shared drug PA record. Nothing re-entered.
            </div>
          )}

          <form onSubmit={submit} className="space-y-3 bg-white rounded border border-teal-200 p-3">
            <div className="text-xs text-teal-700">
              ePA case <code>{benefit.caseId}</code>. Question set from PAInitiationResponse:
            </div>
            {benefit.questions.map((q) => (
              <div key={q.linkId} className="text-sm">
                <label className="block font-medium text-gray-800 mb-1">{q.text}</label>
                {q.type === 'choice' ? (
                  <select
                    className="border border-gray-300 p-2 rounded w-full"
                    value={answers[q.linkId] || ''}
                    onChange={(e) => setAnswers((a) => ({ ...a, [q.linkId]: e.target.value }))}
                    required
                  >
                    <option value="">Select</option>
                    {q.options.map((o) => (
                      <option key={o.code} value={o.code}>
                        {o.code} {o.display}
                      </option>
                    ))}
                  </select>
                ) : (
                  <label className="flex items-center gap-2 text-gray-700">
                    <input
                      type="checkbox"
                      checked={answers[q.linkId] === true}
                      onChange={(e) => setAnswers((a) => ({ ...a, [q.linkId]: e.target.checked }))}
                    />
                    <span>Yes</span>
                  </label>
                )}
              </div>
            ))}
            <button
              type="submit"
              disabled={loading}
              className="bg-teal-700 text-white px-4 py-2 rounded hover:bg-teal-800 font-bold disabled:opacity-50"
            >
              {loading ? 'Sending PARequest...' : 'Submit ePA (PARequest)'}
            </button>
          </form>
        </>
      )}

      {result && (
        <div
          className={`mt-3 rounded border-2 px-4 py-3 ${
            result.decision.determination === 'approved'
              ? 'bg-green-50 border-green-600 text-green-900'
              : 'bg-red-50 border-red-700 text-red-900'
          }`}
        >
          <div className="font-bold">
            {result.decision.determination === 'approved' ? '✓ PAResponse: Approved' : '✗ PAResponse: Denied'} · case{' '}
            {result.caseId}
          </div>
          {result.reason && (
            <div className="text-sm mt-1">
              {result.reason.text}. X12 886 reason{' '}
              <code className="bg-white px-1 rounded">{result.reason.x12.code}</code>, the same code the PAS track returns for
              this denial.
            </div>
          )}
          <ClockBadge clock={result.clock} decidedAt={result.decidedAt} />
          <SharedRecord record={result.record} />
        </div>
      )}

      {(benefit || result) && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-teal-800">
            Show NCPDP messages (illustrative, not certified NCPDP payloads)
          </summary>
          {[...(benefit?.messages || []), ...(result?.messages || [])].map((m) => (
            <div key={m.name} className="mt-2">
              <div className="font-semibold text-teal-900">{m.name}</div>
              <pre className="bg-gray-900 text-teal-100 p-2 rounded overflow-auto max-h-64 text-[10px]">{m.xml}</pre>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

/** The shared drug PA record: one decision, with an entry per benefit track. */
export function SharedRecord({ record }) {
  if (!record) return null;
  const tracks = Object.entries(record.tracks || {});
  return (
    <div className="mt-2 text-xs bg-white/70 rounded border border-gray-300 p-2 text-gray-800">
      <div className="font-semibold mb-1">
        Shared drug PA record: {record.determination || 'no model decision yet'}
        {record.reasonKey && <> · reason {record.reasonKey}</>}
      </div>
      {tracks.map(([track, t]) => (
        <div key={track}>
          {track === 'medical' ? 'Medical (PAS)' : 'Pharmacy (NCPDP)'}: {t.determination}
          {t.debugForced && <> (debug flag, not a model decision)</>}
          {t.noAnswers && <> (no DTR answers submitted, not a model decision)</>}
          {t.hcpcs && <> · HCPCS {t.hcpcs}</>}
          {t.ndc && <> · NDC {t.ndc}</>}
          {t.authNumber && <> · auth {t.authNumber}</>}
          {t.caseId && <> · case {t.caseId}</>}
        </div>
      ))}
    </div>
  );
}
