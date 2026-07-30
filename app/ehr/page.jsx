'use client';
import { useState, useEffect, useMemo } from 'react';
import { apiUrl, BASE_PATH } from '@/lib/basePath';
import { getPatient } from '@/lib/patients';
import { PAS_PROFILES } from '@/lib/fhir';
import {
  getLaunchedSession,
  fetchLaunchedPatient,
  clearLaunchedSession
} from '@/lib/smartLaunch';

/**
 * Provider EHR + DTR SMART surface.
 *
 * - Renders all four CDS Hooks 2.0 indicators (info / warning / critical /
 *   hard-stop) with conformant styling and surfaces card.source.
 * - SMART-app link is a distinct primary CTA button (links[].type === "smart").
 * - Submits a FHIR Bundle on PAS containing Patient + Coverage +
 *   Practitioner + Claim + QuestionnaireResponse.
 * - DTR pane fetches the bound Questionnaire from /api/questionnaire/[id]
 *   and renders item[] dynamically; submits a real QuestionnaireResponse.
 * - Persists the incoming coverage-information system action so it can be
 *   inspected on screen.
 * - Hard-stop debug toggle in the order UI.
 */

// ---- Order picker options --------------------------------------------------
// Each row supplies the inputs the CRD hook needs (code, optional category,
// optional Condition resources). The condition list is what drives the
// J9035 conditional-routing demo.
const ORDER_OPTIONS = [
  // ---- No-PA examples (info indicator) ---------------------------------
  {
    label: '99214 — Office Visit, moderate (No PA)',
    code: '99214',
    category: null,
    conditions: []
  },
  {
    label: '99213 — Office Visit, low (No PA)',
    code: '99213',
    category: null,
    conditions: []
  },
  {
    label: '90471 — Immunization administration (No PA)',
    code: '90471',
    category: null,
    conditions: []
  },
  {
    label: '80050 — General health panel, lab (No PA)',
    code: '80050',
    category: null,
    conditions: []
  },
  {
    label: '36415 — Routine venipuncture (No PA)',
    code: '36415',
    category: null,
    conditions: []
  },
  // ---- PA-required examples --------------------------------------------
  {
    label: '70553 — MRI Brain (Carelon)',
    code: '70553',
    category: null,
    conditions: []
  },
  {
    // The 2026 grids list 15820 on the Medicare Advantage code list only,
    // so this order matches a rule when the MA-PPO scenario (Robert Chen)
    // is selected. PAS pends it for clinical review regardless of plan.
    label: '15820 — Blepharoplasty, Lower Eyelid (MA plan; pends for review)',
    code: '15820',
    category: null,
    conditions: []
  },
  {
    label: 'J9035 — Avastin w/ oncology Dx → Carelon (conditional)',
    code: 'J9035',
    category: null,
    conditions: [
      {
        resourceType: 'Condition',
        clinicalStatus: { coding: [{ code: 'active' }] },
        code: {
          coding: [
            {
              system: 'http://hl7.org/fhir/sid/icd-10-cm',
              code: 'C50.911',
              display: 'Malignant neoplasm of unspecified site of right female breast'
            }
          ]
        }
      }
    ]
  },
  {
    label: 'J9035 — Avastin w/o oncology Dx → BCBSIL (conditional)',
    code: 'J9035',
    category: null,
    conditions: []
  },
  {
    label: '90867 — rTMS Initial (Lucet, BH billing code)',
    code: '90867',
    category: null,
    conditions: []
  },
  {
    label: 'Category-only — Applied Behavior Analysis (Lucet, BH)',
    code: 'NOCODE',
    category: 'Applied Behavior Analysis (ABA)',
    conditions: [
      {
        resourceType: 'Condition',
        clinicalStatus: { coding: [{ code: 'active' }] },
        code: {
          coding: [
            {
              system: 'http://hl7.org/fhir/sid/icd-10-cm',
              code: 'F84.0',
              display: 'Autistic disorder'
            }
          ]
        }
      }
    ]
  },
  {
    label: 'Category-only — Partial Hospitalization Program (Lucet, BH fallback)',
    code: 'NOCODE',
    category: 'Partial Hospitalization Treatment Program',
    conditions: []
  }
];

// ---- Patient scenarios -----------------------------------------------------
// Each scenario drives: patient demographics, plan type, ordering practitioner,
// and a suggested default order. Switching scenarios resets the order form.
// Demographics, plan, and practitioner data come from lib/patients.js (the
// single source of truth shared with the API routes). Only the EHR-specific
// scenario decoration lives here.
const SCENARIO_DECORATIONS = [
  {
    id: 'jane-doe',
    patientId: 'pat-8849-jane-doe',
    defaultOrderIndex: 5,
    presetCode: '',
    tag: 'General PA',
    tagColor: 'bg-blue-100 text-blue-800',
    borderColor: 'border-blue-400',
    description: 'Commercial PPO, 52 F. Full CRD → DTR → PAS arc; MRI Brain routed to Carelon.',
  },
  {
    id: 'robert-chen',
    patientId: 'pat-7712-robert-chen',
    defaultOrderIndex: 5,
    presetCode: '',
    tag: 'Medicare Advantage',
    tagColor: 'bg-teal-100 text-teal-800',
    borderColor: 'border-teal-400',
    description: 'MA-PPO, 70 M. Same code (70553), filtered to MA-specific rule set only.',
  },
  {
    id: 'dorothy-hayes',
    patientId: 'pat-3301-dorothy-hayes',
    defaultOrderIndex: null,
    presetCode: '27447',
    tag: 'Gold Card',
    tagColor: 'bg-yellow-100 text-yellow-800',
    borderColor: 'border-yellow-400',
    description: 'COMM-PPO, 77 F. Dr. Patel is enrolled in the Orthopedic Gold Card — TKA auto-satisfied.',
  },
  {
    id: 'marcus-johnson',
    patientId: 'pat-6614-marcus-johnson',
    defaultOrderIndex: 10,
    presetCode: '',
    tag: 'Behavioral Health',
    tagColor: 'bg-purple-100 text-purple-800',
    borderColor: 'border-purple-400',
    description: 'COMM-HMO, 11 M. ABA therapy with autism Dx; category-match routing to Lucet.',
  },
];

const PATIENT_SCENARIOS = SCENARIO_DECORATIONS.map((d) => ({
  ...getPatient(d.patientId),
  ...d,
}));

// ---- Indicator visual conventions ------------------------------------------
// CDS Hooks 2.0 indicator semantics are normative; rendered colors are an
// implementation convention, not normative. We follow the widely-adopted
// "info=blue, warning=amber, critical=red, hard-stop=dark-red+disabled" set.
const INDICATOR_STYLES = {
  info: {
    container: 'bg-blue-50 border-blue-500',
    heading: 'text-blue-900',
    badge: 'bg-blue-600 text-white',
    icon: 'i',
    badgeText: 'INFO'
  },
  warning: {
    container: 'bg-amber-50 border-amber-500',
    heading: 'text-amber-900',
    badge: 'bg-amber-500 text-white',
    icon: '!',
    badgeText: 'WARNING'
  },
  critical: {
    container: 'bg-red-50 border-red-600',
    heading: 'text-red-900',
    badge: 'bg-red-600 text-white',
    icon: '!!',
    badgeText: 'CRITICAL'
  },
  'hard-stop': {
    container: 'bg-red-100 border-red-800 ring-2 ring-red-800',
    heading: 'text-red-950',
    badge: 'bg-red-900 text-white',
    icon: '⛔',
    badgeText: 'HARD-STOP'
  }
};

// ---- Patient resource builders (scenario-driven) ---------------------------
function buildPatientResource(scenario, orderConditions) {
  return {
    resourceType: 'Patient',
    id: scenario.patientId,
    name: [{ family: scenario.family, given: scenario.given }],
    gender: scenario.gender,
    birthDate: scenario.dob,
    condition: orderConditions || []
  };
}

function buildCoverageResource(scenario) {
  return {
    resourceType: 'Coverage',
    id: scenario.coverageId,
    status: 'active',
    subscriberId: scenario.subscriberId,
    payor: [{ identifier: { value: 'BCBSIL' } }]
  };
}

function buildPractitionerResource(scenario) {
  return {
    resourceType: 'Practitioner',
    id: scenario.practitioner.id,
    name: [{ family: scenario.practitioner.family, given: scenario.practitioner.given }],
    identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: scenario.npi }]
  };
}

function buildClaimResource(scenario, order) {
  return {
    resourceType: 'Claim',
    id: `claim-${Date.now()}`,
    status: 'active',
    use: 'preauthorization',
    patient: { reference: `Patient/${scenario.patientId}` },
    item: [
      {
        sequence: 1,
        productOrService: {
          coding: order.code === 'NOCODE'
            ? []
            : [{ system: 'http://www.ama-assn.org/go/cpt', code: order.code }],
          text: order.category || undefined
        }
      }
    ],
    servicedDate: new Date().toISOString().slice(0, 10)
  };
}

// The PAS endpoint returns a profile-conformant response Bundle
// (ClaimResponse + coverage-information Task as entries). The bare-
// ClaimResponse fallback keeps the page tolerant of the older shape.
function extractPasResponse(json) {
  if (json?.resourceType === 'Bundle') {
    const pick = (type) =>
      json.entry?.find((e) => e?.resource?.resourceType === type)?.resource ||
      null;
    return { claimResponse: pick('ClaimResponse'), task: pick('Task') };
  }
  if (json?.resourceType === 'ClaimResponse') {
    return {
      claimResponse: json,
      task: json.systemActions?.[0]?.resource || null
    };
  }
  return { claimResponse: null, task: null };
}

// Epic's well-known public FHIR sandbox test patients, for the Epic Backend
// Services panel below.
const EPIC_TEST_PATIENTS = [
  { label: 'Camila Lopez', id: 'erXuFYUfucBZaryVksYEcMg3' },
  { label: 'Derrick Lin', id: 'eq081-VQEgP8drUUqCWzHfw3' },
  { label: 'Warren McGinnis', id: 'e0w0LEDCYtfckT6N.CkJKCw3' },
  { label: 'Desiree Powell', id: 'eAB3mDIBBcyUKviyzrxsnAw3' },
  { label: 'Elijah Davis', id: 'egqBHVfQlt4Bw3XGXoxVxHg3' },
  { label: 'Linda Ross', id: 'eIXesllypH3M9tAA5WdJftQ3' },
  { label: 'Olivia Roberts', id: 'eh2xYHuzl9nkSFVvV3osUHg3' }
];

// ---- Page ------------------------------------------------------------------
export default function EhrDashboard() {
  const [scenarioId, setScenarioId] = useState('jane-doe');
  const scenario = useMemo(
    () => PATIENT_SCENARIOS.find((s) => s.id === scenarioId),
    [scenarioId]
  );
  const [selectedIndex, setSelectedIndex] = useState(5); // 70553 MRI Brain (jane-doe default)
  const [planType, setPlanType] = useState('COMM-PPO');
  // Free-text code overrides the preset dropdown when non-empty.
  const [customCode, setCustomCode] = useState('');
  const [hardStopFlag, setHardStopFlag] = useState(false);
  const [card, setCard] = useState(null);
  const [systemAction, setSystemAction] = useState(null);
  const [showDtr, setShowDtr] = useState(false);
  const [questionnaire, setQuestionnaire] = useState(null);
  const [cqlLibrary, setCqlLibrary] = useState(null);
  const [answers, setAnswers] = useState({});
  const [pasResponse, setPasResponse] = useState(null);
  const [pendedId, setPendedId] = useState(null);
  const [wasPended, setWasPended] = useState(false);
  const [launchedSession, setLaunchedSession] = useState(null);
  const [launchedPatient, setLaunchedPatient] = useState(null);
  const [availityResult, setAvailityResult] = useState(null);
  const [availityLoading, setAvailityLoading] = useState(false);
  const [epicPatientId, setEpicPatientId] = useState(EPIC_TEST_PATIENTS[0].id);
  const [epicResult, setEpicResult] = useState(null);
  const [epicError, setEpicError] = useState(null);
  const [epicLoading, setEpicLoading] = useState(false);

  useEffect(() => {
    const session = getLaunchedSession();
    if (!session) return;
    setLaunchedSession(session);
    fetchLaunchedPatient(session)
      .then((p) => setLaunchedPatient(p))
      .catch(() => setLaunchedPatient(null));
  }, []);
  const [simulateDenial, setSimulateDenial] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showLogic, setShowLogic] = useState(false);
  const [smartContext, setSmartContext] = useState(null);

  // When the selected scenario changes, update plan type, default order, and
  // reset all card/response state so the new context starts clean.
  useEffect(() => {
    setPlanType(scenario.planType);
    if (scenario.defaultOrderIndex != null) {
      setSelectedIndex(scenario.defaultOrderIndex);
      setCustomCode('');
    } else {
      setCustomCode(scenario.presetCode || '');
    }
    setCard(null);
    setSystemAction(null);
    setShowDtr(false);
    setPasResponse(null);
    setPendedId(null);
    setWasPended(false);
    setSimulateDenial(false);
    setQuestionnaire(null);
    setCqlLibrary(null);
    setAnswers({});
    setSmartContext(null);
    setLoading(false);
  }, [scenarioId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll for pended PA determination every 2 seconds until finalized.
  useEffect(() => {
    if (!pendedId) return;
    const iv = setInterval(async () => {
      try {
        const res = await fetch(apiUrl(`/api/pas/pended/${pendedId}`));
        if (!res.ok) return;
        const data = await res.json();
        if (data.status === 'finalized') {
          clearInterval(iv);
          const { claimResponse, task } = extractPasResponse(data.responseBundle);
          setPasResponse(claimResponse);
          setSystemAction(task);
          setWasPended(true);
          setPendedId(null);
        }
      } catch { /* ignore transient network errors */ }
    }, 2000);
    return () => clearInterval(iv);
  }, [pendedId]);

  // If the user typed a custom code, synthesize an order around it with
  // no conditions (so conditional routing falls back to BCBSIL). Otherwise
  // use the preset selected from the dropdown.
  const trimmedCustom = customCode.trim();
  const order = trimmedCustom
    ? {
        label: `Custom: ${trimmedCustom}`,
        code: trimmedCustom,
        category: null,
        conditions: []
      }
    : ORDER_OPTIONS[selectedIndex];

  // ---- Phase 2: Sign Order → CDS Hook fires ------------------------------
  const signOrder = async () => {
    setCard(null);
    setSystemAction(null);
    setShowDtr(false);
    setPasResponse(null);
    setQuestionnaire(null);
    setCqlLibrary(null);
    setAnswers({});
    setSmartContext(null);
    setLoading(true);

    const patient = buildPatientResource(scenario, order.conditions);
    const coverage = buildCoverageResource(scenario);
    const payload = {
      hook: 'order-sign',
      hookInstance: `inst-${Date.now()}`,
      code: order.code === 'NOCODE' ? null : order.code,
      serviceCategory: order.category,
      planType,
      practitionerNpi: scenario.npi,
      patient,
      coverage,
      patientId: patient.id,
      coverageId: coverage.id,
      'hard-stop-trigger': hardStopFlag
    };

    const res = await fetch(apiUrl('/api/cds-services/order-sign'), {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    setCard(data.cards?.[0] || null);
    // Persist the incoming coverage-information system action so the EHR
    // can show "machine-readable PA determination has been received" in its
    // own UI rather than only in the UM Dashboard feed.
    setSystemAction(data.systemActions?.[0]?.resource || null);
    setLoading(false);
  };

  // ---- Phase 3: SMART launch → fetch Questionnaire + CQL -----------------
  const launchDtr = async () => {
    if (!card?.links?.[0]) return;
    const link = card.links[0];

    let ctx = {};
    try {
      ctx = link.appContext ? JSON.parse(link.appContext) : {};
    } catch {
      // appContext may be string in production; tolerate either.
    }
    setSmartContext(ctx);
    setShowDtr(true);
    setLoading(true);

    // Fetch the bound Questionnaire.
    const qRes = await fetch(apiUrl(`/api/questionnaire/${ctx.questionnaireId}`));
    const qJson = await qRes.json();
    setQuestionnaire(qJson);

    // Seed answers using the SDC initialExpression — simulator pre-population.
    // Honest framing: pre-population values are hardcoded to match what the
    // bound CQL would return. The simulator does not execute CQL.
    const seeded = {};
    for (const item of qJson.item || []) {
      const expr = item.extension?.find((e) =>
        (e.url || '').includes('initialExpression')
      )?.valueExpression?.expression;
      if (!expr) continue;
      seeded[item.linkId] = simulatedCqlResult(expr);
    }
    setAnswers(seeded);

    // Fetch the CQL library (if bound).
    if (ctx.cqlLibraryId) {
      const cRes = await fetch(apiUrl(`/api/cql/${ctx.cqlLibraryId}`));
      if (cRes.ok) {
        const lib = await cRes.json();
        const raw =
          lib?.content?.[0]?._cqlText ||
          (lib?.content?.[0]?.data
            ? atob(lib.content[0].data)
            : '');
        setCqlLibrary({ id: ctx.cqlLibraryId, text: raw });
      }
    }
    setLoading(false);
  };

  // ---- Phase 4: Submit PAS Bundle ----------------------------------------
  const submitPas = async (e) => {
    e.preventDefault();
    setLoading(true);

    const patient = buildPatientResource(scenario, order.conditions);
    const coverage = buildCoverageResource(scenario);
    const practitioner = buildPractitionerResource(scenario);
    const claim = buildClaimResource(scenario, order);
    const qr = buildQuestionnaireResponse(questionnaire, answers, patient);

    const bundle = {
      resourceType: 'Bundle',
      meta: { profile: [PAS_PROFILES.requestBundle] },
      type: 'collection',
      entry: [
        { resource: patient },
        { resource: coverage },
        { resource: practitioner },
        { resource: claim },
        { resource: qr }
      ],
      serviceCategory: order.category,
      planType,
      _simulateDenial: simulateDenial
    };

    setWasPended(false);
    setAvailityResult(null);
    setAvailityLoading(true);

    // FHIR PAS to the payer directly (per CMS-0057-F) and X12 278 in JSON
    // to the Availity clearinghouse (the legacy channel) go out in
    // parallel. Both take the same PAS Bundle as input.
    const [pasResult, availityResp] = await Promise.allSettled([
      fetch(apiUrl('/api/pas/submit'), {
        method: 'POST',
        body: JSON.stringify(bundle)
      }).then((r) => r.json()),
      fetch(apiUrl('/api/availity/service-review'), {
        method: 'POST',
        body: JSON.stringify(bundle)
      })
        .then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json() }))
        .catch((e) => ({ ok: false, status: 0, json: { error: e.message } }))
    ]);

    if (pasResult.status === 'fulfilled') {
      const data = pasResult.value;
      const { claimResponse, task } = extractPasResponse(data);
      if (claimResponse?.outcome === 'queued') {
        setPendedId(claimResponse.preAuthRef);
        setPasResponse(claimResponse);
      } else {
        setPasResponse(claimResponse);
        setSystemAction(task || systemAction);
      }
    }
    if (availityResp.status === 'fulfilled') {
      setAvailityResult(availityResp.value);
    }
    setAvailityLoading(false);
    setShowDtr(false);
    setLoading(false);
  };

  // ---- Epic Backend Services: read a test patient from Epic's sandbox ---
  const fetchEpicTestPatient = async () => {
    setEpicResult(null);
    setEpicError(null);
    setEpicLoading(true);
    try {
      const res = await fetch(apiUrl(`/api/epic/patient?id=${encodeURIComponent(epicPatientId)}`));
      const data = await res.json();
      if (!res.ok) {
        setEpicError(data?.error || `HTTP ${res.status}`);
      } else {
        setEpicResult(data);
      }
    } catch (e) {
      setEpicError(e.message);
    }
    setEpicLoading(false);
  };

  const indicator = card?.indicator || 'info';
  const style = INDICATOR_STYLES[indicator] || INDICATOR_STYLES.info;
  const isHardStop = indicator === 'hard-stop';

  return (
    <div className="p-8 max-w-6xl mx-auto font-sans bg-gray-50 min-h-screen">
      <h1 className="text-3xl font-bold mb-6 text-blue-900">
        Provider EHR Workspace
      </h1>

      {/* ---- SMART launch: standalone-launch CTA when no session active */}
      {!launchedSession && (
        <div className="mb-6 max-w-3xl bg-slate-50 border border-slate-300 rounded-lg p-4 text-sm">
          <div className="text-xs uppercase tracking-widest text-slate-500 mb-1">
            SMART on FHIR
          </div>
          <div className="text-slate-800 mb-2">
            Launch this app against an external FHIR sandbox to pull a real
            patient into the workspace instead of the demo scenarios below.
          </div>
          <div className="flex gap-3 flex-wrap">
            <a
              href={`${BASE_PATH}/ehr/standalone`}
              className="text-xs px-3 py-1.5 rounded bg-slate-800 text-white hover:bg-slate-900"
            >
              Standalone launch → Epic sandbox
            </a>
            <a
              href="https://launch.smarthealthit.org"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-3 py-1.5 rounded bg-slate-200 text-slate-800 hover:bg-slate-300"
            >
              EHR launch → SMART App Launcher (external)
            </a>
          </div>
          <div className="text-xs text-slate-500 mt-2">
            Epic sandbox test users: <code>FHIRTWO</code> / <code>EpicFhir11!</code>
            (provider with PractitionerRole) or <code>FHIR</code> / <code>EpicFhir11!</code> (provider without).
            SMART App Launcher accepts any practitioner and any test patient.
            Launched data is displayed for the current session only, never persisted.
          </div>
        </div>
      )}

      {/* ---- SMART launch context banner (external EHR launched us) ---- */}
      {launchedSession && (
        <div className="mb-6 max-w-3xl bg-emerald-50 border-2 border-emerald-500 rounded-lg p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="text-sm">
              <div className="text-xs uppercase tracking-widest text-emerald-700 mb-1">
                SMART on FHIR launched context
              </div>
              <div className="text-emerald-900 font-semibold">
                Launched from{' '}
                <code className="bg-emerald-100 px-1 rounded">{new URL(launchedSession.iss).host}</code>
                {launchedSession.patientId && (
                  <>
                    {' '}·{' '}
                    <code className="bg-emerald-100 px-1 rounded">
                      Patient/{launchedSession.patientId}
                    </code>
                  </>
                )}
              </div>
              {launchedPatient && (
                <div className="text-emerald-800 mt-1">
                  {launchedPatient.name?.[0]?.given?.join(' ')} {launchedPatient.name?.[0]?.family}
                  {launchedPatient.birthDate && ` · DOB ${launchedPatient.birthDate}`}
                  {launchedPatient.gender && ` · ${launchedPatient.gender}`}
                </div>
              )}
              <div className="text-emerald-700 text-xs mt-2">
                Scope: <code>{launchedSession.scope}</code>. This banner confirms the OAuth
                exchange completed and a Patient resource was fetched from the launching EHR.
                Order authoring below continues to use the sandbox&apos;s seeded scenarios.
              </div>
            </div>
            <button
              onClick={() => {
                clearLaunchedSession();
                setLaunchedSession(null);
                setLaunchedPatient(null);
              }}
              className="text-xs text-emerald-800 underline hover:text-emerald-900 shrink-0"
            >
              End session
            </button>
          </div>
        </div>
      )}

      {/* ---- Patient / Scenario selector -------------------------------- */}
      <div className="mb-6 max-w-3xl">
        <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">Patient scenarios</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {PATIENT_SCENARIOS.map((s) => (
            <button
              key={s.id}
              onClick={() => setScenarioId(s.id)}
              className={`text-left p-3 rounded-lg border-2 transition-all ${
                scenarioId === s.id
                  ? `${s.borderColor} bg-white shadow-md`
                  : 'border-gray-200 bg-gray-50 hover:bg-white hover:border-gray-300'
              }`}
            >
              <div className="font-semibold text-gray-900 text-sm">{s.name}</div>
              <span className={`inline-block text-xs px-1.5 py-0.5 rounded font-medium mt-1 ${s.tagColor}`}>
                {s.tag}
              </span>
              <div className="text-xs text-gray-500 mt-1 leading-snug">{s.description}</div>
            </button>
          ))}
        </div>
      </div>

      {/* ---- Order entry ------------------------------------------------ */}
      <div className="bg-white shadow rounded-lg p-6 mb-6 border border-gray-200 max-w-3xl">
        <h2 className="text-xl font-semibold mb-4 text-gray-800">
          Order Entry: {scenario.name}
        </h2>
        <div className="text-xs text-gray-500 mb-4 bg-gray-100 p-2 rounded inline-block">
          Patient ({scenario.patientId}) · Coverage ({scenario.coverageId}) · NPI {scenario.npi}
        </div>
        <div className="mb-1 text-xs uppercase tracking-wide text-gray-500">Plan type</div>
        <select
          className="border border-gray-300 p-2 rounded w-full mb-4 text-gray-800"
          value={planType}
          onChange={(e) => setPlanType(e.target.value)}
        >
          <option value="COMM-PPO">Commercial PPO</option>
          <option value="COMM-HMO">Commercial HMO</option>
          <option value="MA-PPO">Medicare Advantage PPO</option>
        </select>
        <div className="mb-1 text-xs uppercase tracking-wide text-gray-500">
          Preset orders
        </div>
        <select
          className={`border border-gray-300 p-2 rounded w-full mb-3 text-gray-800 ${trimmedCustom ? 'opacity-40' : ''}`}
          value={selectedIndex}
          onChange={(e) => setSelectedIndex(Number(e.target.value))}
          disabled={Boolean(trimmedCustom)}
        >
          {ORDER_OPTIONS.map((o, i) => (
            <option key={i} value={i}>
              {o.label}
            </option>
          ))}
        </select>

        <div className="mb-1 text-xs uppercase tracking-wide text-gray-500 flex items-center gap-2">
          <span>Or type any CPT / HCPCS / J-code</span>
          {trimmedCustom && (
            <span className="text-[10px] bg-blue-100 text-blue-800 px-2 py-0.5 rounded font-semibold">
              overriding preset
            </span>
          )}
        </div>
        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={customCode}
            onChange={(e) => setCustomCode(e.target.value)}
            placeholder="e.g. 27447, J9145, 99213"
            className="border border-gray-300 p-2 rounded flex-1 text-gray-800 font-mono"
          />
          {customCode && (
            <button
              type="button"
              onClick={() => setCustomCode('')}
              className="text-sm text-gray-500 hover:text-gray-800 px-2"
              aria-label="Clear custom code"
            >
              ✕
            </button>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-700 mb-2">
          <input
            type="checkbox"
            checked={hardStopFlag}
            onChange={(e) => setHardStopFlag(e.target.checked)}
            className="w-4 h-4"
          />
          <span>
            <strong>Debug:</strong> simulate <code className="text-xs bg-gray-100 px-1 rounded">hard-stop</code> trigger
            (contraindicated/non-covered scenario)
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-700 mb-4">
          <input
            type="checkbox"
            checked={simulateDenial}
            onChange={(e) => setSimulateDenial(e.target.checked)}
            className="w-4 h-4"
          />
          <span>
            <strong>Debug:</strong> simulate <code className="text-xs bg-gray-100 px-1 rounded">denial</code> on PAS submit
            (structured reason codes, CMS-0057-F §1006)
          </span>
        </label>

        <button
          onClick={signOrder}
          disabled={loading}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 w-full font-bold disabled:opacity-50"
        >
          {loading ? 'Evaluating Rules...' : 'Sign Order'}
        </button>
      </div>

      {/* ---- CDS Hooks 2.0 card ---------------------------------------- */}
      {card && (
        <div
          className={`p-5 rounded-lg mb-6 border-l-4 max-w-3xl shadow-sm ${style.container}`}
        >
          <div className="flex items-center gap-3 mb-2">
            <span className={`px-2 py-0.5 rounded text-xs font-bold ${style.badge}`}>
              {style.icon} {style.badgeText}
            </span>
            <h3 className={`font-bold text-lg ${style.heading}`}>{card.summary}</h3>
          </div>
          <p className="text-gray-800 mt-1 whitespace-pre-line">
            {renderMarkdownLite(card.detail)}
          </p>

          {card.source && (
            <div className="mt-3 text-xs text-gray-600 flex items-center gap-2">
              {card.source.icon && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={card.source.icon}
                  alt=""
                  className="w-3 h-3 inline-block"
                  onError={(ev) => (ev.currentTarget.style.display = 'none')}
                />
              )}
              <span>
                Source:{' '}
                <a
                  href={card.source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-blue-700"
                >
                  {card.source.label}
                </a>
              </span>
            </div>
          )}

          {/* SMART app link as the primary CTA -- only when not hard-stop. */}
          {card.links?.length > 0 && !isHardStop && (
            <div className="mt-4 flex flex-wrap gap-2">
              {card.links
                .filter((l) => l.type === 'smart')
                .map((l, i) => (
                  <button
                    key={i}
                    onClick={launchDtr}
                    className="bg-indigo-600 text-white px-5 py-2.5 rounded font-bold hover:bg-indigo-700 shadow flex items-center gap-2"
                  >
                    <span className="text-sm bg-white text-indigo-700 px-1.5 py-0.5 rounded font-mono">SMART</span>
                    ► {l.label}
                  </button>
                ))}
            </div>
          )}

          {/* Hard-stop indicators are non-overridable in CDS Hooks 2.0, so the
              EHR must disable order-sign. Render an explicit disabled affordance. */}
          {isHardStop && (
            <div className="mt-4">
              <button
                disabled
                className="bg-gray-400 text-white px-5 py-2.5 rounded font-bold cursor-not-allowed shadow opacity-70"
              >
                Order-sign disabled (hard-stop)
              </button>
              <p className="text-xs text-red-900 mt-2">
                CDS Hooks 2.0: <code>hard-stop</code> is a non-overridable
                indicator. The EHR must prevent order-sign until the underlying
                condition is resolved.
              </p>
            </div>
          )}

          {card.suggestions?.length > 0 && (
            <div className="mt-4 border-t border-gray-200 pt-3">
              <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                Suggested alternatives
              </div>
              <ul className="text-sm space-y-1">
                {card.suggestions.map((s) => (
                  <li key={s.uuid} className="text-gray-800">
                    • {s.label}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* ---- Persisted coverage-information Task (Da Vinci CRD) -------- */}
      {systemAction && (
        <details className="bg-white border border-gray-200 rounded-lg max-w-3xl mb-6 shadow-sm">
          <summary className="cursor-pointer px-4 py-2 text-sm text-gray-700 font-semibold">
            Da Vinci CRD <code>coverage-information</code> Task (persisted on order)
          </summary>
          <pre className="text-xs bg-gray-900 text-green-300 p-3 overflow-auto rounded-b-lg">
            {JSON.stringify(systemAction, null, 2)}
          </pre>
        </details>
      )}

      {/* ---- DTR Glass Box --------------------------------------------- */}
      {showDtr && questionnaire && (
        <div className="bg-white border border-gray-300 shadow-xl rounded-xl overflow-hidden mt-6 flex flex-col md:flex-row">
          <div className={`p-6 ${showLogic ? 'md:w-1/2 border-r border-gray-200' : 'w-full'}`}>
            <div className="flex justify-between items-center mb-6">
              <div>
                <h2 className="text-xl font-bold text-indigo-900">{questionnaire.title}</h2>
                <div className="text-xs text-gray-500 mt-1">
                  Questionnaire/{questionnaire.id} · v{questionnaire.version}
                </div>
              </div>
              <button
                onClick={() => setShowLogic(!showLogic)}
                className="text-sm font-semibold text-gray-600 hover:text-indigo-600 bg-indigo-50 px-3 py-1 rounded-full border border-indigo-100"
              >
                {showLogic ? 'Hide Developer View' : '</> View CQL Logic'}
              </button>
            </div>

            <form onSubmit={submitPas} className="space-y-5">
              {(questionnaire.item || []).map((item) => (
                <QuestionnaireItem
                  key={item.linkId}
                  item={item}
                  value={answers[item.linkId]}
                  onChange={(v) =>
                    setAnswers((prev) => ({ ...prev, [item.linkId]: v }))
                  }
                />
              ))}
              <button
                type="submit"
                disabled={loading}
                className="bg-indigo-600 text-white px-4 py-3 rounded-lg hover:bg-indigo-700 w-full font-bold shadow disabled:opacity-50"
              >
                {loading ? 'Submitting…' : 'Submit PAS Request'}
              </button>
            </form>

            <p className="text-xs text-gray-500 mt-4">
              CQL shown is illustrative. The simulator does not execute CQL;
              pre-population values are hardcoded to match the logic shown.
            </p>
          </div>

          {showLogic && (
            <div className="md:w-1/2 bg-[#1e1e1e] flex flex-col h-[500px] md:h-auto border-l border-gray-700">
              <DeveloperPane questionnaire={questionnaire} cql={cqlLibrary} />
            </div>
          )}
        </div>
      )}

      {/* ---- PAS response ---------------------------------------------- */}
      {pendedId && (
        <div className="bg-amber-50 border-2 border-amber-500 text-amber-900 px-6 py-4 rounded-lg shadow-sm mt-6 max-w-3xl">
          <div className="flex items-center gap-3 mb-1">
            <span className="inline-block w-4 h-4 border-2 border-amber-600 border-t-transparent rounded-full animate-spin flex-shrink-0" />
            <div className="font-bold text-lg">PA Pended — Clinical Review Required</div>
          </div>
          <div className="text-sm mt-1">
            Auth #: <code className="bg-white px-1 rounded">{pasResponse?.preAuthRef}</code> ·
            Sent to: <strong>{pasResponse?.insurer?.display}</strong>
          </div>
          <div className="text-sm mt-2 text-amber-800">{pasResponse?.disposition}</div>
          <div className="text-xs mt-2 text-amber-700 bg-amber-100 px-2 py-1 rounded font-mono">
            rest-hook notification (R4 Subscriptions Backport) will fire to this EHR when the determination is finalized.
          </div>
        </div>
      )}

      {pasResponse && !pendedId && pasResponse.outcome === 'error' && (
        <div className="bg-red-50 border-2 border-red-700 text-red-900 px-6 py-4 rounded-lg shadow-sm mt-6 max-w-3xl">
          <div className="font-bold text-lg mb-2">✗ {pasResponse.disposition}</div>
          {(pasResponse.reviewAction?.reasonCode || []).map((rc, i) => {
            const coding = rc.coding?.[0];
            return (
              <div key={i} className="mb-2">
                <div className="text-sm font-semibold">
                  Reason code:{' '}
                  <code className="bg-white px-1 rounded text-red-800">
                    {coding?.code}
                  </code>{' '}
                  <span className="font-normal">— {coding?.display}</span>
                </div>
                {rc.text && (
                  <div className="text-sm mt-1 text-red-800 italic">&ldquo;{rc.text}&rdquo;</div>
                )}
              </div>
            );
          })}
          {(pasResponse.error || []).map((err, i) => {
            const coding = err.code?.coding?.[0];
            return coding ? (
              <div key={i} className="text-xs mt-1 text-red-700">
                X12 AAA: <code className="bg-white px-1 rounded">{coding.code}</code> — {coding.display}
              </div>
            ) : null;
          })}
          <div className="text-xs mt-3 text-red-700 bg-red-100 px-2 py-1 rounded font-mono">
            Structured denial reason required per CMS-0057-F (effective Jan 1, 2026). Appeal rights apply.
          </div>
        </div>
      )}

      {pasResponse && !pendedId && pasResponse.outcome !== 'error' && (
        <div className="bg-green-50 border-2 border-green-600 text-green-900 px-6 py-4 rounded-lg shadow-sm mt-6 max-w-3xl">
          <div className="font-bold text-lg">✓ {pasResponse.disposition}</div>
          <div className="text-sm mt-1">
            Auth #: <code className="bg-white px-1 rounded">{pasResponse.preAuthRef}</code> ·
            Reviewed by: <strong>{pasResponse.insurer?.display}</strong>
          </div>
          {wasPended && (
            <div className="text-xs mt-2 text-green-700 bg-green-100 px-2 py-1 rounded font-mono">
              Received via rest-hook notification — pended request finalized after clinical review.
            </div>
          )}
        </div>
      )}

      {/* Availity clearinghouse parallel path ------------------------------ */}
      {(availityLoading || availityResult) && (
        <div className="bg-sky-50 border-2 border-sky-600 text-sky-900 px-6 py-4 rounded-lg shadow-sm mt-4 max-w-3xl">
          <div className="text-xs uppercase tracking-widest text-sky-700 mb-1">
            Availity clearinghouse (parallel X12 278 path)
          </div>
          {availityLoading && !availityResult ? (
            <div className="text-sm">Submitting to Availity Service Reviews demo tier...</div>
          ) : availityResult?.ok ? (
            <>
              <div className="font-bold">
                ✓ {availityResult.json?.response?.statusDescription || 'Response received'}
              </div>
              <div className="text-sm mt-1">
                Cert #:{' '}
                <code className="bg-white px-1 rounded">
                  {availityResult.json?.response?.certificationNumber}
                </code>{' '}
                · Control #:{' '}
                <code className="bg-white px-1 rounded">
                  {availityResult.json?.response?.controlNumber}
                </code>{' '}
                · Mode:{' '}
                <code className="bg-white px-1 rounded">{availityResult.json?.mode}</code>
              </div>
              {availityResult.json?.response?._mock && (
                <div className="text-xs mt-2 text-sky-800 bg-sky-100 px-2 py-1 rounded">
                  Mock response. Set AVAILITY_CLIENT_ID and AVAILITY_CLIENT_SECRET on
                  Cloud Run to route to the real Availity demo tier.
                </div>
              )}
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-sky-700">Show request/response JSON</summary>
                <pre className="bg-white p-2 rounded mt-1 overflow-x-auto text-[10px]">
                  {JSON.stringify(availityResult.json, null, 2)}
                </pre>
              </details>
            </>
          ) : (
            <div className="text-sm">
              Availity call failed: {availityResult?.json?.error || `HTTP ${availityResult?.status}`}
            </div>
          )}
        </div>
      )}

      {/* Epic Backend Services panel ----------------------------------- */}
      <div className="bg-sky-50 border-2 border-sky-600 text-sky-900 px-6 py-4 rounded-lg shadow-sm mt-4 max-w-3xl">
        <div className="text-xs uppercase tracking-widest text-sky-700 mb-1">
          Epic Backend Services (SMART client-confidential-asymmetric)
        </div>
        <p className="text-sm text-sky-800 mb-3">
          In production, DTR pre-population pulls clinical context from the
          provider&rsquo;s EHR. This panel performs that call for real against
          Epic&rsquo;s public FHIR sandbox, using SMART Backend Services
          (RS384-signed client assertion, published JWKS).
        </p>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <select
            value={epicPatientId}
            onChange={(e) => setEpicPatientId(e.target.value)}
            className="text-sm border border-sky-300 rounded px-2 py-1.5 bg-white"
          >
            {EPIC_TEST_PATIENTS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <button
            onClick={fetchEpicTestPatient}
            disabled={epicLoading}
            className="text-sm font-semibold bg-sky-600 text-white px-3 py-1.5 rounded hover:bg-sky-700 disabled:opacity-50"
          >
            {epicLoading ? 'Fetching…' : 'Fetch from Epic sandbox'}
          </button>
          {epicResult?.mode && (
            <span className="text-xs font-mono px-2 py-1 rounded bg-sky-100 text-sky-800 border border-sky-200">
              mode: {epicResult.mode}
            </span>
          )}
        </div>

        {epicError && (
          <div className="text-sm text-red-700">Epic call failed: {epicError}</div>
        )}

        {epicResult?.patient && (
          <div className="text-sm">
            <div>
              <strong>
                {[epicResult.patient.name?.[0]?.given?.join(' '), epicResult.patient.name?.[0]?.family]
                  .filter(Boolean)
                  .join(' ') || '(no name returned)'}
              </strong>
            </div>
            <div className="text-xs mt-1">
              DOB: <code className="bg-white px-1 rounded">{epicResult.patient.birthDate || '—'}</code>{' '}
              · Gender: <code className="bg-white px-1 rounded">{epicResult.patient.gender || '—'}</code>
            </div>
            {(epicResult.patient.identifier || []).length > 0 && (
              <div className="text-xs mt-1">
                Identifiers:{' '}
                {epicResult.patient.identifier.map((id, i) => (
                  <code key={i} className="bg-white px-1 rounded mr-1">
                    {id.value}
                  </code>
                ))}
              </div>
            )}
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-sky-700">Show signed client assertion claims</summary>
              <pre className="bg-white p-2 rounded mt-1 overflow-x-auto text-[10px]">
                {epicResult.assertionClaims
                  ? JSON.stringify(epicResult.assertionClaims, null, 2)
                  : 'No assertion sent — mock mode does not call Epic.'}
              </pre>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- QuestionnaireItem ----------------------------------------------------
function QuestionnaireItem({ item, value, onChange }) {
  const hasCqlPrePop = !!item.extension?.find((e) =>
    (e.url || '').includes('initialExpression')
  );

  const labelBlock = (
    <label className="block mb-2 font-medium text-gray-800">
      {item.text}
      {item.required && <span className="text-red-600 ml-1">*</span>}
    </label>
  );

  const badge = hasCqlPrePop && (
    <div className="flex items-center gap-2 text-sm mb-2">
      <span className="bg-green-100 text-green-800 px-2 py-0.5 rounded text-xs font-semibold border border-green-200">
        Auto-populated via CQL ({item.extension.find((e) => (e.url || '').includes('initialExpression')).valueExpression.expression})
      </span>
    </div>
  );

  switch (item.type) {
    case 'boolean':
      return (
        <div className="bg-indigo-50/50 p-4 rounded-lg border border-indigo-100">
          {labelBlock}
          {badge}
          <label className="flex items-center gap-2 text-gray-700">
            <input
              type="checkbox"
              checked={!!value}
              onChange={(e) => onChange(e.target.checked)}
              className="w-4 h-4 text-indigo-600 rounded"
              required={item.required}
            />
            <span>Yes</span>
          </label>
        </div>
      );

    case 'attachment':
      return (
        <div>
          {labelBlock}
          <input
            type="file"
            onChange={(e) => onChange(e.target.files?.[0]?.name || '')}
            className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:border-0 file:bg-indigo-50 file:text-indigo-700 rounded border p-2"
            required={item.required}
          />
        </div>
      );

    case 'string':
      return (
        <div>
          {labelBlock}
          {badge}
          <input
            type="text"
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            className="border border-gray-300 p-2 rounded w-full"
            required={item.required}
          />
        </div>
      );

    case 'text':
      return (
        <div>
          {labelBlock}
          {badge}
          <textarea
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            className="border border-gray-300 p-2 rounded w-full"
            rows={3}
            required={item.required}
          />
        </div>
      );

    case 'choice':
      return (
        <div>
          {labelBlock}
          <select
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            className="border border-gray-300 p-2 rounded w-full"
            required={item.required}
          >
            <option value="">— Select —</option>
            {(item.answerOption || []).map((opt, i) => {
              const v = opt.valueCoding?.code || opt.valueString || opt.valueInteger;
              const d = opt.valueCoding?.display || opt.valueString || String(v);
              return (
                <option key={i} value={v}>
                  {d}
                </option>
              );
            })}
          </select>
        </div>
      );

    default:
      return (
        <div className="text-sm text-gray-500">
          (Unsupported item type: <code>{item.type}</code>)
        </div>
      );
  }
}

// ---- Developer pane (Glass Box) -------------------------------------------
function DeveloperPane({ questionnaire, cql }) {
  const [tab, setTab] = useState('questionnaire');
  return (
    <div className="flex flex-col h-full">
      <div className="bg-[#2d2d2d] px-4 py-2 border-b border-gray-700 flex gap-2">
        <button
          onClick={() => setTab('questionnaire')}
          className={`text-xs font-mono px-2 py-1 rounded ${tab === 'questionnaire' ? 'bg-gray-700 text-white' : 'text-gray-400'}`}
        >
          Questionnaire JSON
        </button>
        <button
          onClick={() => setTab('cql')}
          className={`text-xs font-mono px-2 py-1 rounded ${tab === 'cql' ? 'bg-gray-700 text-white' : 'text-gray-400'}`}
          disabled={!cql}
        >
          CQL Library{cql ? `: ${cql.id}.cql` : ' (none bound)'}
        </button>
      </div>
      <div className="p-4 flex-grow overflow-auto text-sm font-mono leading-relaxed">
        {tab === 'questionnaire' ? (
          <pre className="text-blue-300">
            <code>{JSON.stringify(questionnaire, null, 2)}</code>
          </pre>
        ) : (
          <pre className="text-green-400 whitespace-pre-wrap">
            <code>{cql?.text || '// No CQL library bound to this rule.'}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

// ---- Simulated CQL evaluation ---------------------------------------------
// Honest framing (also surfaced as a tooltip in the DTR pane): the simulator
// does not execute CQL. These hardcoded returns mirror what each library's
// `define` block would produce in a real environment.
function simulatedCqlResult(expression) {
  switch (expression) {
    case 'FunctionalImpairmentPresent':
      return true;
    case 'PrimaryOncologyDiagnosis':
      return 'C50.911';
    case 'HasPriorConservativeTherapy':
      return true;
    case 'HasQualifyingDevelopmentalDiagnosis':
      return true;
    case 'HasPriorAntidepressantTrials':
      return true;
    default:
      return null;
  }
}

// ---- QuestionnaireResponse builder ----------------------------------------
function buildQuestionnaireResponse(questionnaire, answers, patient) {
  const items = (questionnaire?.item || []).map((item) => {
    const v = answers[item.linkId];
    const ans = answerByType(item.type, v);
    return {
      linkId: item.linkId,
      text: item.text,
      ...(ans ? { answer: [ans] } : {})
    };
  });
  return {
    resourceType: 'QuestionnaireResponse',
    id: `qr-${Date.now()}`,
    questionnaire: questionnaire?.url,
    status: 'completed',
    authored: new Date().toISOString(),
    subject: { reference: `Patient/${patient.id}` },
    item: items
  };
}

function answerByType(type, value) {
  if (value === undefined || value === null || value === '') return null;
  switch (type) {
    case 'boolean':
      return { valueBoolean: !!value };
    case 'attachment':
      return { valueAttachment: { title: String(value), contentType: 'application/pdf' } };
    case 'string':
      return { valueString: String(value) };
    case 'text':
      return { valueString: String(value) };
    case 'choice':
      return { valueCoding: { code: String(value) } };
    default:
      return { valueString: String(value) };
  }
}

// ---- Very small markdown helper (bold only) -------------------------------
// card.detail is markdown-capable per CDS Hooks 2.0. We only need bold for
// the demo headlines; a real client would plug in a markdown renderer.
function renderMarkdownLite(text) {
  if (!text) return '';
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    /^\*\*[^*]+\*\*$/.test(p)
      ? <strong key={i}>{p.slice(2, -2)}</strong>
      : <span key={i}>{p}</span>
  );
}
