'use client';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { apiUrl } from '@/lib/basePath';
import { authedFetch } from '@/lib/smartClient';
import { PATIENT_LIST } from '@/lib/patients';
import { DRUG_CATALOG } from '@/lib/drugPa';
import DrugPriorAuths from '@/app/components/DrugPriorAuths';

const SCOPES = ['system/ExplanationOfBenefit.read', 'system/Coverage.read'];
const DEFAULT_NDC = DRUG_CATALOG.certolizumab.siteOfCare.self.ndc;

/**
 * Pharmacy PA lookup (CMS-0062-P position 2). A community pharmacy enters
 * the member ID and NDC it is dispensing and reads PA status, benefit, and
 * formulary data over a SMART-scoped FHIR read, with no proprietary portal.
 */
export default function PharmacyLookup() {
  const [memberId, setMemberId] = useState(PATIENT_LIST[0].subscriberId);
  const [ndc, setNdc] = useState(DEFAULT_NDC);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  // Bumped per lookup and per input change, so only the latest reply renders.
  const reqRef = useRef(0);

  const lookup = async (e) => {
    e.preventDefault();
    const mine = ++reqRef.current;
    setLoading(true);
    try {
      const res = await authedFetch(
        apiUrl(`/api/pharmacy/pa-status?memberId=${encodeURIComponent(memberId)}&ndc=${encodeURIComponent(ndc)}`),
        SCOPES
      );
      const json = await res.json();
      if (reqRef.current === mine) setResult({ status: res.status, json });
    } catch (err) {
      if (reqRef.current === mine) setResult({ status: 0, json: { error: err.message } });
    } finally {
      if (reqRef.current === mine) setLoading(false);
    }
  };

  const json = result?.json;
  const eobs = (json?.bundle?.entry || []).map((e) => e.resource);

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 font-mono p-8">
      <div className="border-b border-gray-700 pb-4 mb-6 flex justify-between items-center flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-teal-400">Pharmacy PA Lookup</h1>
          <p className="text-xs text-gray-500 mt-1">
            CMS-0062-P (proposed) · PA status, RTPB, and F&amp;B for the dispensing pharmacy · SMART backend-services scopes
          </p>
        </div>
        <Link href="/" className="text-xs text-blue-400 hover:text-blue-300 underline">Home</Link>
      </div>

      <form onSubmit={lookup} className="flex flex-wrap gap-3 items-end mb-6">
        <label className="text-xs text-gray-400">
          Member ID
          <select
            value={memberId}
            onChange={(e) => { reqRef.current += 1; setLoading(false); setMemberId(e.target.value); setResult(null); }}
            className="block mt-1 bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-sm text-gray-200"
          >
            {PATIENT_LIST.map((p) => (
              <option key={p.id} value={p.subscriberId}>{p.subscriberId} ({p.name})</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-gray-400">
          NDC
          <input
            value={ndc}
            onChange={(e) => { reqRef.current += 1; setLoading(false); setNdc(e.target.value); setResult(null); }}
            className="block mt-1 bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-sm text-gray-200 w-40"
          />
        </label>
        <button
          type="submit"
          disabled={loading}
          className="bg-teal-700 hover:bg-teal-600 text-white text-sm font-semibold px-4 py-1.5 rounded disabled:opacity-50"
        >
          {loading ? 'Looking up…' : 'Look up PA status'}
        </button>
      </form>

      {result && result.status !== 200 && (
        <div className="text-sm text-amber-300 bg-amber-950/40 border border-amber-700 rounded p-3 mb-4">
          HTTP {result.status}: {json?.error || json?.issue?.[0]?.diagnostics || 'Lookup failed'}
        </div>
      )}

      {result?.status === 200 && (
        <div className="space-y-4">
          <div className="grid md:grid-cols-2 gap-3 text-sm">
            <div className="bg-gray-800 border border-gray-700 rounded p-3">
              <div className="text-xs uppercase tracking-wide text-gray-400">RTPB</div>
              {json.benefit.rtpb.coverageStatus} · PA required: {json.benefit.rtpb.priorAuthorizationRequired ? 'yes' : 'no'}
            </div>
            <div className="bg-gray-800 border border-gray-700 rounded p-3">
              <div className="text-xs uppercase tracking-wide text-gray-400">F&amp;B formulary</div>
              {json.benefit.formulary.formularyStatus} · {json.benefit.formulary.coverageFactors.join(', ')}
            </div>
          </div>
          {eobs.length ? (
            <DrugPriorAuths eobs={eobs} title={`PA status for ${json.drug.name}`} />
          ) : (
            <div className="text-sm text-gray-400 bg-gray-800 border border-gray-700 rounded p-3">
              No prior authorization on file for this member and drug. Run the certolizumab order from the EHR first.
            </div>
          )}
          <p className="text-xs text-gray-500">
            Same PDex Prior Authorization EOBs the Patient Access and Provider Access APIs return, so the pharmacy sees the decision and reason the prescriber saw.
          </p>
        </div>
      )}
    </div>
  );
}
