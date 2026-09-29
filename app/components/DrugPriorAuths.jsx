'use client';

/**
 * Drug prior authorizations as PDex Prior Authorization EOBs (from the
 * access APIs). Reads the decision from PDex's extension-reviewAction on
 * item.adjudication, the same X12 306 action and 886 reason the PAS and
 * NCPDP tracks produce.
 */
const PDEX_REVIEW_ACTION = 'http://hl7.org/fhir/us/davinci-pdex/StructureDefinition/extension-reviewAction';

function review(eob) {
  for (const adj of eob.item?.[0]?.adjudication || []) {
    const ext = (adj.extension || []).find((e) => e.url === PDEX_REVIEW_ACTION);
    if (!ext) continue;
    const sub = (u) => ext.extension?.find((e) => e.url === u || e.url.endsWith(u));
    const reason = sub('reasonCode')?.valueCodeableConcept;
    return {
      action: sub('extension-reviewActionCode')?.valueCodeableConcept?.coding?.[0]?.code,
      reasonCode: reason?.coding?.[0]?.code,
      reasonText: reason?.text
    };
  }
  return {};
}

export default function DrugPriorAuths({ eobs, title = 'Drug prior authorizations' }) {
  if (!eobs?.length) return null;
  return (
    <div className="bg-gray-900 border border-teal-800 rounded-lg p-4 mb-4">
      <div className="text-xs uppercase tracking-wide text-teal-300 mb-2">
        {title}
        <span className="ml-2 text-gray-500 normal-case">
          ({eobs.length}) · ExplanationOfBenefit, use preauthorization, PDex-shaped · drug exclusion removed under CMS-0062-P (proposed)
        </span>
      </div>
      <div className="space-y-2">
        {eobs.map((eob) => {
          const r = review(eob);
          const coding = eob.item?.[0]?.productOrService?.coding?.[0];
          const approved = r.action === 'A1';
          const qty = eob.item?.[0]?.quantity;
          return (
            <div
              key={eob.id}
              className={`rounded border p-2 text-xs ${approved ? 'border-green-700 bg-green-950/30' : 'border-red-700 bg-red-950/30'}`}
            >
              <div className="flex justify-between gap-2">
                <span className="text-gray-100 font-semibold">{eob.item?.[0]?.productOrService?.text}</span>
                <span className={approved ? 'text-green-300' : 'text-red-300'}>
                  {approved ? 'APPROVED' : 'DENIED'} ({r.action})
                </span>
              </div>
              <div className="text-gray-400 mt-0.5">
                {eob.type?.coding?.[0]?.code === 'pharmacy' ? 'Pharmacy benefit' : 'Medical benefit'} ·{' '}
                {coding?.system?.endsWith('/ndc') ? 'NDC' : 'HCPCS'} <code className="text-gray-200">{coding?.code}</code>
                {qty && <> · quantity {qty.value} {qty.unit}</>} · auth <code className="text-gray-200">{eob.preAuthRef?.[0]}</code>
              </div>
              {!approved && (
                <div className="text-red-300 mt-0.5">
                  {r.reasonText}
                  {r.reasonCode && <code className="ml-1 bg-red-900 px-1 rounded">X12 886 {r.reasonCode}</code>}
                </div>
              )}
              <div className="text-gray-500 mt-0.5">
                {eob.meta?.profile?.[0]
                  ? 'Profile: PDex Prior Authorization'
                  : 'No profile claimed: the PDex PA profile only admits CPT, HCPCS, and HIPPS codes, not NDC'}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
