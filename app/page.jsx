import Link from 'next/link';

const REPO_URL = 'https://github.com/msampath/cms-0057-sandbox';
const PLAN_URL = 'https://github.com/msampath/cms-0057-sandbox/blob/main/docs/cms-0062-p-implementation-plan.md';

const FINAL_RULE_FACTS = [
  { label: 'Final rule', value: 'CMS-0057-F' },
  { label: 'Regulation', value: '45 CFR 156.221-156.223' },
  { label: 'API compliance date', value: 'January 1, 2027' },
  { label: 'Operational provisions', value: 'January 1, 2026' }
];

const PROPOSED_RULE_FACTS = [
  { label: 'Status', value: 'Proposed, 91 FR 19890' },
  { label: 'Drug PA', value: 'October 1, 2027 (proposed)' },
  { label: 'Prior standard versions expire', value: 'January 1, 2028 (proposed)' },
  { label: 'FHIR PAS as HIPAA standard', value: '24 months after the final rule (proposed)' }
];

const API_MAP = [
  { cite: '156.223', api: 'Prior Authorization API (CRD → DTR → PAS)', where: '/ehr + /um Live Traffic Feed' },
  { cite: '156.221(a)', api: 'Patient Access API', where: '/patient' },
  { cite: '156.222(a)', api: 'Provider Access API', where: '/um Provider Access tab' },
  { cite: '156.222(b)', api: 'Payer-to-Payer API ($member-match)', where: '/um P2P Exchange tab' }
];

const PROPOSED_ADDITIONS = [
  {
    cite: '45 CFR 170.205(b)(2), (c)(1), (u)(1)',
    feature: 'Proposed drug PA on the pharmacy benefit over NCPDP SCRIPT ePA, with RTPB and F&B.',
    where: '/ehr: self-administered certolizumab order'
  },
  {
    cite: 'Proposed CMS-0062-P',
    feature: 'Drug PA on the medical benefit through CRD, DTR and PAS.',
    where: '/ehr: clinic-administered certolizumab order'
  },
  {
    cite: 'My position',
    feature: 'One question set, one decision and one coded denial reason across both drug tracks.',
    where: '/ehr: clinic-administered certolizumab order'
  },
  {
    cite: 'SSA 1927(d)(5), proposed 45 CFR 156.223(i)(1)(ii), 42 CFR 422.568, 422.572',
    feature: 'Decision clocks by program, with a citation on each decision. Medicaid has a 24-hour covered outpatient drug clock and a 72-hour emergency supply. Proposed QHP drug clocks are 24 hours expedited and 72 hours standard. MA Part B drug decisions use 42 CFR 422.568 and 422.572. Commercial employer plans have no federal clock.',
    where: '/ehr decision badges and /um Live Traffic Feed'
  },
  {
    cite: 'Proposed 45 CFR 156.221(b)(1)(v)',
    feature: 'Proposed drug PAs in Patient Access, Provider Access, and Payer-to-Payer as PDex Prior Authorization ExplanationOfBenefit resources, with parallel MA, Medicaid, and CHIP sections.',
    where: '/patient, /um Provider Access, and /um P2P Exchange'
  },
  {
    cite: 'Sandbox addition',
    feature: 'A pharmacy PA lookup lets a dispensing pharmacy read the same decision as the prescriber over a SMART-scoped FHIR read. This is not a rule requirement.',
    where: '/pharmacy'
  },
  {
    cite: 'Proposed 45 CFR 170.215',
    feature: 'Versioned standards from one registry, with the proposed versions and their sunset dates. Patient Access uses US Core 6.1.0 because US Core 3.1.1 expired from 170.215 on January 1, 2026.',
    where: '/um Standards tab'
  },
  {
    cite: 'Proposed CMS-0062-P',
    feature: 'An endpoint report of FHIR Endpoint resources, API usage reporting, and PA metrics as counts and percentages.',
    where: '/um Registry & Metrics tab'
  },
  {
    cite: 'My position',
    feature: 'Third-party connection success and error rates.',
    where: '/um Registry & Metrics tab'
  },
  {
    cite: 'Proposed 45 CFR 162.1302(g)(2)(vii)',
    feature: 'CDex attachments on pended requests.',
    where: '/ehr: pended 15820 order and the DTR pane clearinghouse toggle'
  },
  {
    cite: 'Sandbox addition',
    feature: 'A clearinghouse gate that rejects a nonconforming PAS Bundle before it reaches the payer.',
    where: '/ehr: pended 15820 order and the DTR pane clearinghouse toggle'
  }
];

const START_PATH = [
  { href: '/um', label: '/um', text: 'Open the UM dashboard. The rule index is pre-loaded. Search 70553 in the Rules Explorer to see the MRI Brain rule, its routing, and its provenance back to the source PDF page.' },
  { href: '/ehr', label: '/ehr', text: 'Open the EHR as Jane Doe and sign the MRI Brain order. A CDS Hooks card returns with the DTR questionnaire link. Complete it and submit the PAS request.' },
  { href: '/um', label: '/um', text: 'Back in the UM dashboard, watch the Live Traffic Feed. Expand the FHIR ↔ X12 drawer on the X12 278 REQUEST entry to inspect the field-to-segment mapping.' },
  { href: '/patient', label: '/patient', text: 'Open the patient portal as Jane Doe. The same determination appears in her prior authorization history through the Patient Access API.' },
  { href: '/um', label: '/um', text: 'In the P2P Exchange tab, run $member-match for a newly enrolled member and retrieve the prior plan PA history.' }
];

const PROPOSED_PATH = [
  { href: '/ehr', label: '/ehr', text: 'Pick a certolizumab order, self-administered or clinic-administered, and leave the step therapy box unchecked. Run the other order to see the answers carry over and both tracks deny with the same reason.' },
  { href: '/ehr', label: '/ehr', text: 'Select Maria Santos for Medicaid or David Kim for QHP, then sign the default order to see the decision clock for that program.' },
  { href: '/pharmacy', label: '/pharmacy', text: 'Look up Jane Doe and the certolizumab NDC.' },
  { href: '/um', label: '/um', text: 'Open the Standards and Registry & Metrics tabs.' }
];

function RuleFacts({ title, facts }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-widest text-slate-400 mb-3">{title}</div>
      <div className="grid grid-cols-2 gap-3">
        {facts.map((fact) => (
          <div key={fact.label} className="bg-slate-950/60 border border-slate-700 rounded p-3">
            <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">{fact.label}</div>
            <div className="text-sm font-semibold text-slate-100">{fact.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PathList({ steps }) {
  return (
    <ol className="space-y-2">
      {steps.map((step, index) => (
        <li key={index} className="flex gap-3 text-sm">
          <span className="shrink-0 w-6 h-6 rounded-full bg-slate-700 text-slate-200 flex items-center justify-center text-xs font-bold">
            {index + 1}
          </span>
          <span className="text-slate-300">
            <Link href={step.href} className="text-blue-300 hover:text-blue-200 underline font-mono text-xs mr-1.5">
              {step.label}
            </Link>
            {step.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

export default function Landing() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-800 text-slate-100 p-8">
      <div className="max-w-4xl mx-auto">
        <div className="text-xs uppercase tracking-widest text-emerald-400 mb-2 mt-4">
          CMS-0057-F final rule and CMS-0062-P proposed rule sandbox
        </div>
        <h1 className="text-4xl font-bold mb-3">
          The four CMS-0057-F payer APIs working end to end, extended to the proposed CMS-0062-P drug rule
        </h1>
        <p className="text-slate-300 mb-6 max-w-3xl">
          This sandbox implements the four payer FHIR APIs that the CMS Interoperability and Prior Authorization final rule (CMS-0057-F) requires. CMS-0062-P, proposed on April 14, 2026, would extend prior authorization to drugs, make FHIR PAS a HIPAA standard, and add reporting, and the sandbox models those proposals too. The rule data comes from about 3,154 rules extracted from four publicly available 2026 BCBSIL prior authorization grids.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          <RuleFacts title="CMS-0057-F final" facts={FINAL_RULE_FACTS} />
          <RuleFacts title="CMS-0062-P proposed" facts={PROPOSED_RULE_FACTS} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
          <Link href="/um" className="block bg-emerald-700 hover:bg-emerald-600 rounded-lg p-5 shadow ring-2 ring-emerald-400">
            <div className="text-xs uppercase tracking-widest text-emerald-200 mb-1">Payer</div>
            <div className="text-xl font-bold mb-1">UM Dashboard</div>
            <div className="text-sm text-emerald-100">Rules Explorer, Live Traffic Feed, Provider Access, P2P Exchange, proposed drug decision clocks, standards, and reporting.</div>
          </Link>
          <Link href="/ehr" className="block bg-blue-700 hover:bg-blue-600 rounded-lg p-5 shadow">
            <div className="text-xs uppercase tracking-widest text-blue-200 mb-1">Provider</div>
            <div className="text-xl font-bold mb-1">EHR Workspace</div>
            <div className="text-sm text-blue-100">Order entry → CDS Hooks card → DTR questionnaire → PAS Bundle, with proposed pharmacy and medical benefit drug PA tracks.</div>
          </Link>
          <Link href="/patient" className="block bg-indigo-700 hover:bg-indigo-600 rounded-lg p-5 shadow">
            <div className="text-xs uppercase tracking-widest text-indigo-200 mb-1">Member</div>
            <div className="text-xl font-bold mb-1">Patient Portal</div>
            <div className="text-sm text-indigo-100">Coverage card, SMART scopes, and prior authorization history, including proposed drug PA resources.</div>
          </Link>
          <Link href="/pharmacy" className="block bg-teal-700 hover:bg-teal-600 rounded-lg p-5 shadow">
            <div className="text-xs uppercase tracking-widest text-teal-200 mb-1">Pharmacy</div>
            <div className="text-xl font-bold mb-1">Pharmacy PA lookup</div>
            <div className="text-sm text-teal-100">A sandbox addition where a dispensing pharmacy uses a SMART-scoped FHIR read to see the prescriber decision.</div>
          </Link>
        </div>

        <div className="bg-slate-950/60 border border-slate-700 rounded-lg p-4 mb-8">
          <div className="text-xs uppercase tracking-widest text-slate-400 mb-3">The four mandated APIs and where they live</div>
          <div className="space-y-2">
            {API_MAP.map((row) => (
              <div key={row.cite} className="flex flex-col md:flex-row md:items-center gap-1 md:gap-3 text-sm">
                <code className="text-emerald-300 shrink-0 w-28">{row.cite}</code>
                <span className="text-slate-200 flex-1">{row.api}</span>
                <code className="text-slate-400 text-xs">{row.where}</code>
              </div>
            ))}
          </div>
          <div className="text-xs text-slate-500 mt-3">
            45 CFR sections shown are for QHP issuers. Parallel sections: MA 42 CFR 422.119, 422.121, 422.122 · Medicaid 42 CFR 431.60, 431.61, 431.80 · CHIP 42 CFR 457.730, 457.731, 457.732.
          </div>
        </div>

        <div className="bg-slate-950/60 border border-slate-700 rounded-lg p-4 mb-8">
          <div className="text-xs uppercase tracking-widest text-slate-400 mb-3">What CMS-0062-P adds, and where it lives</div>
          <div className="space-y-4">
            {PROPOSED_ADDITIONS.map((row) => (
              <div key={`${row.cite}-${row.where}`} className="grid grid-cols-1 md:grid-cols-[11rem_1fr] gap-1 md:gap-3 text-sm">
                <code className="text-emerald-300 text-xs">{row.cite}</code>
                <div>
                  <div className="text-slate-200">{row.feature}</div>
                  <code className="text-slate-400 text-xs">{row.where}</code>
                </div>
              </div>
            ))}
          </div>
          <div className="text-xs text-slate-500 mt-4">
            CMS-0062-P is proposed. Citations follow the proposed text and may change in the final rule. Read the{' '}
            <a href={PLAN_URL} target="_blank" rel="noreferrer" className="text-blue-300 hover:text-blue-200 underline">plan and positions document</a>.
          </div>
        </div>

        <div className="mb-8">
          <div className="text-xs uppercase tracking-widest text-slate-400 mb-3">A suggested path through the demo</div>
          <p className="text-sm text-slate-400 mb-3 max-w-3xl">
            The sandbox boots pre-seeded with the full rule index and a replayed demo session, so every surface has data before the first click. The steps below walk one order through all four APIs.
          </p>
          <PathList steps={START_PATH} />
        </div>

        <div className="mb-8">
          <div className="text-xs uppercase tracking-widest text-slate-400 mb-3">The CMS-0062-P additions</div>
          <PathList steps={PROPOSED_PATH} />
        </div>

        <div className="border-t border-slate-700 pt-4 pb-8 text-xs text-slate-400 space-y-2">
          <div>
            <a href={REPO_URL} className="text-blue-300 hover:text-blue-200 underline" target="_blank" rel="noreferrer">Source on GitHub</a>
            {' '}· AGPL-3.0 licensed. The source for this deployment is the repository linked above.
          </div>
          <div>
            <a href={PLAN_URL} target="_blank" rel="noreferrer" className="text-blue-300 hover:text-blue-200 underline">CMS-0062-P plan and positions document</a>
          </div>
          <div>
            Demonstration environment with synthetic patients. The rule data comes from publicly available BCBSIL documents (
            <a href="https://www.bcbsil.com/docs/provider/il/claims/um/2026-ma-pa-codelist-q2.pdf" target="_blank" rel="noopener noreferrer" className="text-blue-300 hover:text-blue-200 underline">Medicare Advantage</a>,{' '}
            <a href="https://www.bcbsil.com/docs/provider/il/claims/um/2026-commercial-med-surg-pa-code-list.pdf" target="_blank" rel="noopener noreferrer" className="text-blue-300 hover:text-blue-200 underline">Commercial Med-Surg</a>,{' '}
            <a href="https://www.bcbsil.com/docs/provider/il/claims/um/2026-commercial-specialty-pharmacy-pa-code-list.pdf" target="_blank" rel="noopener noreferrer" className="text-blue-300 hover:text-blue-200 underline">Specialty Pharmacy</a>,{' '}
            <a href="https://www.bcbsil.com/docs/provider/il/claims/um/2026-commercial-bh-pa-code-list.pdf" target="_blank" rel="noopener noreferrer" className="text-blue-300 hover:text-blue-200 underline">Behavioral Health</a>
            ). This project is not affiliated with or endorsed by BCBSIL, CMS, Epic, Availity, Optum, or Prime Therapeutics.
          </div>
          <div>
            <strong className="text-slate-300">Data use.</strong> This sandbox processes only synthetic patient data by default. When launched from an external EHR sandbox via SMART on FHIR, the launched Patient resource is fetched and displayed for the current browser session only. Nothing is persisted, sold, shared, or used for any secondary purpose. Access tokens live in sessionStorage and clear on tab close or when the &quot;End session&quot; control is used.
          </div>
          <div>The Reset demo control in the UM dashboard restores the seeded baseline at any time.</div>
        </div>
      </div>
    </main>
  );
}
