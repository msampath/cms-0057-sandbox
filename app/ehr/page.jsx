'use client';
import { useState, useEffect, useMemo, useRef } from 'react';
import { apiUrl, BASE_PATH } from '@/lib/basePath';
import { getPatient } from '@/lib/patients';
import { PAS_PROFILES, readReviewAction } from '@/lib/fhir';
import PharmacyEpa, { SharedRecord } from './pharmacyEpa';
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
  },
  // ---- Drug PA: one drug, two benefits (CMS-0062-P) --------------------
  // Same drug, different site of care. J0717 is the real BCBSIL commercial
  // specialty pharmacy grid row, which reads "not for use when drug is self
  // administered". The self-administered syringe goes to the pharmacy
  // benefit over NCPDP instead of CRD. Both share lib/drugPa.js.
  {
    label: 'J0717 — Certolizumab (Cimzia), clinic-administered → medical benefit (PAS)',
    code: 'J0717',
    category: null,
    conditions: [],
    drug: 'certolizumab',
    siteOfCare: 'clinic'
  },
  {
    label: 'Certolizumab (Cimzia), self-administered syringe → pharmacy benefit (NCPDP)',
    code: 'J0717',
    category: null,
    conditions: [],
    drug: 'certolizumab',
    siteOfCare: 'self'
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

function epicPatientDisplayName(patient) {
  return (
    [patient?.name?.[0]?.given?.join(' '), patient?.name?.[0]?.family]
      .filter(Boolean)
      .join(' ') || null
  );
}

// Turns a fetched Epic Patient resource into the same "scenario" shape
// buildPatientResource/buildCoverageResource/buildPractitionerResource
// already consume for the four demo patients (see lib/patients.js).
// Identity (name/DOB/gender/id) is real, pulled from Epic's sandbox. The
// payer coverage fields are synthesized -- Epic's sandbox has no BCBSIL
// data -- so this is explicitly a demo blend, not a claim that Epic and
// BCBSIL are connected.
function buildEpicScenario(epicResult, fhirId) {
  const patient = epicResult?.patient;
  const family = patient?.name?.[0]?.family || 'Patient';
  const given = patient?.name?.[0]?.given || ['Epic'];
  const memberSuffix = fhirId.replace(/[^A-Za-z0-9]/g, '').slice(-6).toUpperCase();
  return {
    id: fhirId,
    patientId: fhirId,
    name: epicPatientDisplayName(patient) || 'Epic Sandbox Patient',
    family,
    given,
    dob: patient?.birthDate || '1970-01-01',
    gender: patient?.gender || 'unknown',
    planType: 'COMM-PPO',
    planName: 'Commercial PPO',
    coverageId: `cov-comm-ppo-bcbsil-epic-${memberSuffix}`,
    subscriberId: `BCBSIL-MEM-EPIC-${memberSuffix}`,
    npi: '1234567890',
    practitioner: { id: 'pract-555-smith', family: 'Smith', given: ['Ada'] },
    tag: epicResult?.mode === 'live' ? 'Epic Sandbox (live)' : 'Epic Sandbox (mock)',
    tagColor: 'bg-sky-100 text-sky-800',
    borderColor: 'border-sky-400',
    description:
      'Real Epic FHIR identity via SMART Backend Services. Coverage, member ID, and ordering NPI below are synthesized for this demo.',
    defaultOrderIndex: 5,
    presetCode: ''
  };
}

// ---- Page ------------------------------------------------------------------
export default function EhrDashboard() {
  const [scenarioId, setScenarioId] = useState('jane-doe');
  // Populated only when the user explicitly opts in from the Epic panel
  // below (see the "Use ... for the PA order flow" button). Fetching a
  // preview in that panel does not change this on its own.
  const [epicScenario, setEpicScenario] = useState(null);
  const scenario = useMemo(() => {
    if (scenarioId === 'epic-patient' && epicScenario) return epicScenario;
    return PATIENT_SCENARIOS.find((s) => s.id === scenarioId);
  }, [scenarioId, epicScenario]);
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
  // Bumped on each Sign Order for a pharmacy-benefit drug order; keys a
  // fresh PharmacyEpa panel. 0 hides it.
  const [pharmacyRun, setPharmacyRun] = useState(0);
  // Which track, if any, the DTR answers were carried over from.
  const [drugPrefillFrom, setDrugPrefillFrom] = useState(null);
  // Shared drug PA record, read back after a medical-track PAS decision.
  const [drugRecord, setDrugRecord] = useState(null);
  const pasReview = readReviewAction(pasResponse);
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
  // Optum Real Prior Authorization / Provider Access -- a third,
  // independent payer implementation of the same CMS-0057-F APIs. Three
  // touch points mirror the three phases of the order flow: order-sign
  // gets a second real CRD opinion, DTR launch gets a real reference
  // questionnaire, PAS submit gets a third parallel determination.
  const [optumOrderSign, setOptumOrderSign] = useState(null);
  const [optumOrderSignLoading, setOptumOrderSignLoading] = useState(false);
  const [optumQuestionnaire, setOptumQuestionnaire] = useState(null);
  const [optumQuestionnaireLoading, setOptumQuestionnaireLoading] = useState(false);
  const [optumPasResult, setOptumPasResult] = useState(null);
  const [optumPasLoading, setOptumPasLoading] = useState(false);
  // DTR pre-population via CQL against Epic-fetched FHIR data.
  // Populated only when the active scenario is an Epic test patient
  // and the user clicks "Pre-populate from Epic via CQL" in the DTR pane.
  const [prepop, setPrepop] = useState(null);
  const [prepopLoading, setPrepopLoading] = useState(false);
  const [prepopFilledLinks, setPrepopFilledLinks] = useState({}); // linkId -> defineName
  // Invalidation token for in-flight prepop requests. A plain closure
  // over `scenarioId`/`scenario`/`questionnaire` cannot detect a
  // context change post-await because those are `const` bindings from
  // the render that scheduled the async call -- a later render's
  // state change never mutates that closure. The ref persists across
  // renders and is bumped either at kickoff (marking a new request as
  // the winner) or by invalidatePrepop() / the context-change effect
  // below (marking every in-flight request as superseded), so an
  // already-running invocation can dereference `.current` and see
  // the truth.
  const prepopReqRef = useRef(0);
  // AbortController for the currently in-flight /api/dtr/prepopulate
  // fetch, if any. Held in a ref so invalidatePrepop() can cancel it
  // synchronously and reclaim the network slot -- otherwise clearing
  // prepopLoading would let the user re-click Pre-populate while the
  // stale request is still on the wire, doubling the traffic and
  // misrepresenting the loading state.
  const prepopAbortRef = useRef(null);
  // Request-supersession counter for outbound Epic Patient reads.
  // fetchEpicTestPatient captures myReq at kickoff and only applies
  // its result if myReq === epicFetchReqRef.current at resolve time.
  // Bumped by (a) every fetchEpicTestPatient kickoff (so an older
  // in-flight call is superseded by a newer click), and (b) any
  // non-Epic scenario switch (so the user's deliberate move to a
  // static scenario is not silently reverted when a stale Epic
  // fetch finally resolves and unconditionally sets scenarioId
  // back to 'epic-patient').
  const epicFetchReqRef = useRef(0);
  // Order-context version counter -- bumped on any change that would
  // invalidate an in-flight order-sign / PAS / Optum / Availity /
  // DTR-questionnaire fetch:
  //   (a) scenario switch or Epic patient swap (via scenario-reset effect)
  //   (b) order-picker or plan-type edit (via invalidateOrderContext)
  // Long-running fetches stamp `myVersion = scenarioVersionRef.current`
  // at kickoff and only apply their result if the version still
  // matches at resolve time. Otherwise a mid-flight change could let
  // a fetch scoped to the OLD context silently overwrite state
  // belonging to the NEW context (cross-patient or cross-order).
  const scenarioVersionRef = useRef(0);
  // Single entry point for "the current DTR context is going away or
  // being replaced". Called synchronously from every user action that
  // changes scenarioId / scenario.patientId / questionnaire.id so
  // that in-flight prepop requests bail out before their fetch
  // resolves. Also clears prepop state and the loading flag directly
  // -- do not rely on the identity-change effect below for this,
  // because the effect only re-fires when a dep VALUE actually
  // changes, so idempotent re-clicks (re-launching DTR for the same
  // questionnaire, re-picking the active Epic patient) would leave
  // the loading indicator stuck otherwise.
  const invalidatePrepop = () => {
    prepopReqRef.current += 1;
    if (prepopAbortRef.current) {
      prepopAbortRef.current.abort();
      prepopAbortRef.current = null;
    }
    setPrepopLoading(false);
    setPrepop(null);
    setPrepopFilledLinks({});
  };

  // Called when the user edits the order picker (preset select,
  // custom code) or plan-type -- any change that means the current
  // order-scoped state and any in-flight order-scoped fetches now
  // belong to the WRONG order. Bumps scenarioVersionRef unconditionally
  // so all in-flight order-scoped fetches' stillCurrent() guards fire,
  // and clears order-scoped state regardless of whether DTR is
  // currently showing -- the CDS card, Optum panels, Availity panel,
  // and PAS response can all be stale even before Launch DTR is
  // clicked (signOrder populates them but keeps showDtr false), and
  // leaving them in place lets the user open the OLD order's DTR
  // via the CDS card's SMART link and submit a cross-order Bundle.
  // React 18 bails out on same-value setState calls, so this is
  // cheap on keystrokes where nothing is actually dirty.
  const invalidateOrderContext = () => {
    scenarioVersionRef.current += 1;
    setPharmacyRun(0);
    setDrugPrefillFrom(null);
    setDrugRecord(null);
    setShowDtr(false);
    setQuestionnaire(null);
    setCqlLibrary(null);
    setAnswers({});
    setSmartContext(null);
    setCard(null);
    setSystemAction(null);
    setPasResponse(null);
    setPendedId(null);
    setWasPended(false);
    setOptumOrderSign(null);
    setOptumOrderSignLoading(false);
    setOptumQuestionnaire(null);
    setOptumQuestionnaireLoading(false);
    setOptumPasResult(null);
    setOptumPasLoading(false);
    setAvailityResult(null);
    setAvailityLoading(false);
    // Debug toggles are per-order-attempt sandbox levers, not
    // persistent preferences -- same rationale the scenario-reset
    // effect uses. Carrying them across an order-picker edit would
    // silently trip a hard-stop / denial on an order the user didn't
    // opt into that debug mode for.
    setHardStopFlag(false);
    setSimulateDenial(false);
    // Also clear the generic `loading` flag -- signOrder / launchDtr /
    // submitPas set it true and would normally clear it in their own
    // completion path, but their stillCurrent() bail (fired by the
    // ref bump above) returns before hitting setLoading(false),
    // leaving both the Sign Order and Submit PAS buttons stuck
    // disabled otherwise.
    setLoading(false);
    invalidatePrepop();
  };

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
    // Bump the scenario version so any in-flight order-sign / PAS /
    // Optum / Availity fetch discards its response when it resolves
    // -- gating check in each fetch's .then guard. Fires on mount
    // (harmless: nothing in flight) and on every scenario or Epic
    // patient change.
    scenarioVersionRef.current += 1;
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
    setPharmacyRun(0);
    setDrugPrefillFrom(null);
    setDrugRecord(null);
    setSimulateDenial(false);
    // Reset debug toggles too -- hardStopFlag is a per-order-attempt
    // sandbox lever, not a persistent user preference. Carrying it
    // forward would silently trip a hard-stop CDS response on a
    // patient the user hadn't opted into that debug mode for.
    setHardStopFlag(false);
    setQuestionnaire(null);
    setCqlLibrary(null);
    setAnswers({});
    setSmartContext(null);
    setLoading(false);
    setOptumOrderSign(null);
    setOptumOrderSignLoading(false);
    setOptumQuestionnaire(null);
    setOptumQuestionnaireLoading(false);
    setOptumPasResult(null);
    setOptumPasLoading(false);
    setAvailityResult(null);
    setAvailityLoading(false);
    setPrepop(null);
    setPrepopFilledLinks({});
    // NOTE: the *Loading flags above are cleared here because each
    // fetch's own stillCurrent()-gated finally skips its own clear on
    // supersession -- without this the spinner panel gated on
    // `(xLoading || xResult)` would keep rendering after a scenario
    // switch, even though no request is actually in flight.
    // Depends on scenario.patientId as well so that switching between
    // two Epic sandbox patients (which keeps scenarioId === 'epic-patient'
    // but changes the underlying identity) triggers a full DTR reset --
    // otherwise the DTR panel keeps rendering the prior patient's
    // questionnaire + answers while the page header shows the new one,
    // and a subsequent Submit PAS would emit a cross-patient FHIR Bundle.
  }, [scenarioId, scenario.patientId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Invalidate any in-flight CQL prepop request whenever the identity
  // it was made for changes. Bumping the ref makes the running
  // invocation's `myReq !== prepopReqRef.current` check fire and
  // discard the (now cross-context) result. Also releases the loading
  // flag so a state-driven cancellation (patient switch without a
  // new click) doesn't leave the button stuck on "Evaluating...".
  useEffect(() => {
    prepopReqRef.current += 1;
    setPrepopLoading(false);
    setPrepop(null);
    setPrepopFilledLinks({});
  }, [scenarioId, scenario.patientId, questionnaire?.id]);

  // Poll for pended PA determination every 2 seconds until finalized.
  useEffect(() => {
    if (!pendedId) return;
    // Capture the scenario version at effect setup. If the user
    // switches scenarios between polls, the interval is cleared by
    // the effect's cleanup -- but a fetch already awaiting inside a
    // prior interval tick keeps running to completion. Without this
    // guard, its `finalized` branch would call setPasResponse etc.
    // and paint the old patient's determination into the newly
    // selected patient's state.
    const pollVersion = scenarioVersionRef.current;
    const iv = setInterval(async () => {
      try {
        const res = await fetch(apiUrl(`/api/pas/pended/${pendedId}`));
        if (!res.ok) return;
        const data = await res.json();
        if (scenarioVersionRef.current !== pollVersion) return;
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
    // Also clear the pended state -- otherwise re-signing the same
    // order after a prior submission that pended leaves pendedId set,
    // the pending poll still running for the OLD preAuthRef, and its
    // late 'finalized' payload will overwrite whatever the new
    // submission returns. The pended-banner render also gates on
    // pendedId, so the stale "PA Pended" message would hide the new
    // response entirely.
    setPendedId(null);
    setWasPended(false);
    setQuestionnaire(null);
    setCqlLibrary(null);
    setAnswers({});
    setSmartContext(null);
    setOptumOrderSign(null);
    setAvailityResult(null);
    // DTR CQL prepop is tied to a specific questionnaire + order. All
    // questionnaires reuse generic sequential linkIds ("1", "2", "3")
    // for different question text, so leaving stale prepopFilledLinks
    // in place across orders would mislabel unrelated fields with a
    // "Prefilled from live CQL" badge for a define that never ran.
    // Also invalidates any in-flight prepop request synchronously.
    invalidatePrepop();
    setDrugPrefillFrom(null);
    setDrugRecord(null);

    // Pharmacy-benefit drug orders skip CRD. They go to the PBM over
    // NCPDP (RTPB → F&B → ePA), rendered by the PharmacyEpa panel.
    if (order.siteOfCare === 'self') {
      scenarioVersionRef.current += 1;
      setPharmacyRun((n) => n + 1);
      return;
    }
    setPharmacyRun(0);

    setLoading(true);
    // Stamp the scenario version at kickoff -- every fetch below
    // gates its state write on this so a scenario switch mid-flight
    // discards the stale response instead of overwriting the
    // newly-selected patient's just-reset state.
    const myVersion = scenarioVersionRef.current;
    const stillCurrent = () => scenarioVersionRef.current === myVersion;

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
    if (!stillCurrent()) return; // scenario switched mid-flight; drop
    setCard(data.cards?.[0] || null);
    // Persist the incoming coverage-information system action so the EHR
    // can show "machine-readable PA determination has been received" in its
    // own UI rather than only in the UM Dashboard feed.
    setSystemAction(data.systemActions?.[0]?.resource || null);
    setLoading(false);

    // Optum Real Prior Authorization: a second, independent CRD opinion
    // on the same order, from UnitedHealthcare's actual engine. Only
    // meaningful for a real service code -- skip for category-only orders.
    if (order.code && order.code !== 'NOCODE') {
      setOptumOrderSignLoading(true);
      fetch(apiUrl('/api/optum/cds-order-sign'), {
        method: 'POST',
        body: JSON.stringify({
          patientId: patient.id,
          practitionerId: scenario.practitioner.id,
          code: order.code,
          display: order.label
        })
      })
        .then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json() }))
        .then((result) => { if (stillCurrent()) setOptumOrderSign(result); })
        .catch((err) => { if (stillCurrent()) setOptumOrderSign({ ok: false, json: { error: err.message } }); })
        .finally(() => { if (stillCurrent()) setOptumOrderSignLoading(false); });

      // Availity Coverages: verify the patient has active eligibility at
      // the payer via a real clearinghouse call (X12 270/271). Fires
      // alongside the CRD hook, non-blocking.
      setAvailityLoading(true);
      fetch(apiUrl('/api/availity/coverage-check'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patientId: patient.id })
      })
        .then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json() }))
        .then((result) => { if (stillCurrent()) setAvailityResult(result); })
        .catch((err) => { if (stillCurrent()) setAvailityResult({ ok: false, json: { error: err.message } }); })
        .finally(() => { if (stillCurrent()) setAvailityLoading(false); });
    }
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
    // Stamp the scenario version so this launch's fetches are
    // discarded if the user changes scenario or Epic patient
    // mid-flight -- otherwise a late Optum DTR-questionnaire response
    // for patient A could land in patient B's DTR panel.
    const myVersion = scenarioVersionRef.current;
    const stillCurrent = () => scenarioVersionRef.current === myVersion;

    let qJson;
    try {
      // Fetch the bound Questionnaire. Guard the whole thing: a 404
      // or non-JSON body would otherwise reject the async function
      // silently, sticking `loading` true forever and skipping the
      // prepop-invalidation guard below (which would let an
      // in-flight prepop from the previous questionnaire land its
      // results into indeterminate state).
      const qRes = await fetch(apiUrl(`/api/questionnaire/${ctx.questionnaireId}`));
      if (!qRes.ok) {
        throw new Error(`Questionnaire fetch failed: HTTP ${qRes.status}`);
      }
      qJson = await qRes.json();
    } catch (e) {
      if (!stillCurrent()) return; // scenario switched during the fetch
      setLoading(false);
      // Also invalidate any in-flight prepop -- we opened the DTR
      // panel then failed to load a new questionnaire; the prior
      // questionnaire (if any) is still rendered underneath, so
      // treat this as an identity change to be safe.
      invalidatePrepop();
      setQuestionnaire(null);
      // Roll back showDtr and clear the Optum reference panel too --
      // otherwise the DTR pane collapses (questionnaire=null gates
      // the main form) but the Optum panel, gated only on showDtr,
      // keeps rendering stale data from a prior successful launch.
      setShowDtr(false);
      setOptumQuestionnaire(null);
      setOptumQuestionnaireLoading(false);
      return;
    }
    if (!stillCurrent()) return; // scenario switched mid-flight
    // Sync invalidate before scheduling the new questionnaire so an
    // in-flight prepop from the previous questionnaire cannot race
    // ahead of the identity effect and land its results here -- but
    // only when the questionnaire identity is actually changing.
    // Re-launching DTR for the same questionnaire (e.g. re-clicking
    // the SMART launch button) must not clear a valid results panel
    // whose CQL was run against this exact questionnaire.
    const questionnaireChanged = questionnaire?.id !== qJson?.id;
    if (questionnaireChanged) invalidatePrepop();
    setQuestionnaire(qJson);

    // Seed answers using the SDC initialExpression -- simulator
    // pre-population. Only re-seed when the questionnaire actually
    // changed; otherwise a same-questionnaire re-launch would silently
    // discard every manually-typed answer for items without an
    // initialExpression and revert prepop-derived values.
    if (questionnaireChanged) {
      const seeded = {};
      for (const item of qJson.item || []) {
        const expr = item.extension?.find((e) =>
          (e.url || '').includes('initialExpression')
        )?.valueExpression?.expression;
        if (!expr) continue;
        seeded[item.linkId] = simulatedCqlResult(expr);
      }
      setAnswers(seeded);
    }

    // Drug orders: carry over answers already given on the pharmacy
    // track from the shared drug PA record, so nothing is re-asked.
    if (order.drug) {
      try {
        const pid = buildPatientResource(scenario, order.conditions).id;
        const rRes = await fetch(apiUrl(`/api/drug-pa/record?patientId=${encodeURIComponent(pid)}&drugKey=${order.drug}`));
        const { record } = await rRes.json();
        if (stillCurrent() && record?.answers) {
          setAnswers((a) => ({ ...a, ...record.answers }));
          setDrugPrefillFrom(record.tracks?.pharmacy ? 'pharmacy' : null);
        }
      } catch {
        // Prefill is a convenience; the form still works empty.
      }
    }

    // Fetch the CQL library (if bound). Tolerant on failure -- library
    // is only a reference display, not required for DTR to function.
    if (ctx.cqlLibraryId) {
      try {
        const cRes = await fetch(apiUrl(`/api/cql/${ctx.cqlLibraryId}`));
        if (stillCurrent() && cRes.ok) {
          const lib = await cRes.json();
          if (stillCurrent()) {
            const raw =
              lib?.content?.[0]?._cqlText ||
              (lib?.content?.[0]?.data
                ? atob(lib.content[0].data)
                : '');
            setCqlLibrary({ id: ctx.cqlLibraryId, text: raw });
          }
        }
      } catch {
        // Library fetch is optional -- swallow and move on.
      }
    }
    if (!stillCurrent()) return;
    setLoading(false);

    // Optum Real DTR: a reference panel showing what a real payer's DTR
    // questionnaire looks like for this kind of request. Informational
    // only -- the form above continues to drive this sandbox's own PAS
    // submission.
    const patient = buildPatientResource(scenario, order.conditions);
    setOptumQuestionnaireLoading(true);
    fetch(apiUrl('/api/optum/dtr-questionnaire'), {
      method: 'POST',
      body: JSON.stringify({ patientId: patient.id })
    })
      .then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json() }))
      .then((result) => { if (stillCurrent()) setOptumQuestionnaire(result); })
      .catch((err) => { if (stillCurrent()) setOptumQuestionnaire({ ok: false, json: { error: err.message } }); })
      .finally(() => { if (stillCurrent()) setOptumQuestionnaireLoading(false); });
  };

  // ---- Phase 4: Submit PAS Bundle ----------------------------------------
  const submitPas = async (e) => {
    e.preventDefault();
    setLoading(true);
    // Stamp the scenario version at kickoff so a mid-flight scenario
    // switch causes both PAS branches to discard their results
    // instead of overwriting the new patient's just-reset state.
    const myVersion = scenarioVersionRef.current;
    const stillCurrent = () => scenarioVersionRef.current === myVersion;

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
    // Clear the previous shared drug record so it cannot sit under a new
    // response while the read-back is in flight.
    setDrugRecord(null);
    // Also clear pendedId at the top so re-submitting the same order
    // starts from a clean pended state. Otherwise a prior 'queued'
    // outcome's preAuthRef persists, and if the new submission
    // returns non-queued, its response is hidden by the still-shown
    // pended banner (which gates on pendedId).
    setPendedId(null);
    setPasResponse(null);
    setSystemAction(null);
    setOptumPasResult(null);
    setOptumPasLoading(true);

    // Two parallel PAS paths for the same Bundle: FHIR PAS to this
    // sandbox's own payer engine (per CMS-0057-F), and Claim/$submit to
    // Optum's real, independent implementation of the same Da Vinci PAS
    // operation. The Availity clearinghouse call is a pre-order
    // eligibility check now, fired earlier in signOrder() -- see there.
    const [pasResult, optumResp] = await Promise.allSettled([
      fetch(apiUrl('/api/pas/submit'), {
        method: 'POST',
        body: JSON.stringify(bundle)
      }).then((r) => r.json()),
      fetch(apiUrl('/api/optum/pas-submit'), {
        method: 'POST',
        body: JSON.stringify(bundle)
      })
        .then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json() }))
        .catch((e) => ({ ok: false, status: 0, json: { error: e.message } }))
    ]);

    if (!stillCurrent()) return; // scenario switched mid-flight
    if (pasResult.status === 'fulfilled') {
      const data = pasResult.value;
      const { claimResponse, task } = extractPasResponse(data);
      if (readReviewAction(claimResponse)?.actionCode === 'A4') {
        setPendedId(claimResponse.preAuthRef);
        setPasResponse(claimResponse);
      } else {
        setPasResponse(claimResponse);
        setSystemAction(task || systemAction);
      }
      if (order.drug) {
        fetch(apiUrl(`/api/drug-pa/record?patientId=${encodeURIComponent(patient.id)}&drugKey=${order.drug}`))
          .then((r) => r.json())
          .then(({ record }) => { if (stillCurrent()) setDrugRecord(record); })
          .catch(() => {});
      }
    }
    if (optumResp.status === 'fulfilled') {
      setOptumPasResult(optumResp.value);
    }
    setOptumPasLoading(false);
    setShowDtr(false);
    setLoading(false);
  };

  // ---- Epic Backend Services: read a test patient from Epic's sandbox ---
  // Called directly from a Patient scenarios card click: fetches the real
  // Epic identity and, on success, activates it as the current scenario in
  // one step (no separate "use this patient" click needed).
  const fetchEpicTestPatient = async (id) => {
    // Claim a request token BEFORE the await. Any later kickoff, or
    // any deliberate non-Epic scenario switch (which also bumps this
    // ref, see PATIENT_SCENARIOS click below), makes our resolution
    // check `epicFetchReqRef.current !== myReq` fire and skip the
    // state update -- otherwise a stale Epic fetch could resolve
    // AFTER the user picked jane-doe / john-smith and silently
    // revert their deliberate selection.
    epicFetchReqRef.current += 1;
    const myReq = epicFetchReqRef.current;
    setEpicPatientId(id);
    setEpicResult(null);
    setEpicError(null);
    setEpicLoading(true);
    try {
      const res = await fetch(apiUrl(`/api/epic/patient?id=${encodeURIComponent(id)}`));
      const data = await res.json();
      if (epicFetchReqRef.current !== myReq) {
        // Superseded -- the user has moved on. Skip everything the
        // apply-branch would have done, including setScenarioId.
        return;
      }
      if (!res.ok) {
        setEpicError(data?.error || `HTTP ${res.status}`);
      } else {
        // Invalidate SYNCHRONOUSLY (before React schedules the
        // re-render) but only if identity is actually changing --
        // re-clicking the currently-active Epic patient would
        // otherwise clear the prepop results panel and per-field
        // badges while leaving the answers themselves populated,
        // stranding the questionnaire in a state where filled fields
        // have no visible CQL provenance.
        const identityChanged =
          scenarioId !== 'epic-patient' || scenario.patientId !== id;
        if (identityChanged) invalidatePrepop();
        setEpicResult(data);
        setEpicScenario(buildEpicScenario(data, id));
        setScenarioId('epic-patient');
      }
    } catch (e) {
      if (epicFetchReqRef.current === myReq) {
        setEpicError(e.message);
      }
    } finally {
      if (epicFetchReqRef.current === myReq) {
        setEpicLoading(false);
      }
    }
  };

  // ---- DTR pre-population via CQL against Epic-fetched FHIR data --------
  // Only wired when the active scenario is an Epic test patient. Calls
  // /api/dtr/prepopulate which fetches Patient + Condition + Observation
  // from Epic (mock in dev), runs the MRIBrainPrepopulation ELM against
  // that Bundle, and returns evaluated define values. We map the demo
  // demographic defines to questionnaire items by heuristic text match
  // and populate answers; the clinical define renders in a summary panel
  // above the form.
  const runCqlPrepop = async () => {
    if (scenarioId !== 'epic-patient') return;
    // Claim a fresh request token. The identity-change effect above
    // bumps prepopReqRef whenever scenarioId, scenario.patientId, or
    // questionnaire?.id changes; comparing prepopReqRef.current
    // against `myReq` after the await tells us whether ANY of those
    // changed while we were in flight, without needing a closure over
    // the live state (which would be frozen at kickoff).
    prepopReqRef.current += 1;
    const myReq = prepopReqRef.current;
    // Capture the identifiers we actually SENT to the server so we can
    // use them for both the request body and any downstream lookups
    // that depend on the state as it was at kickoff.
    const requestPatientId = scenario.patientId;
    const requestQuestionnaireItems = questionnaire?.item || [];
    // Register an AbortController so invalidatePrepop() can cancel
    // this fetch (freeing the network slot and firing our AbortError
    // handler) if the user changes context mid-flight.
    const controller = new AbortController();
    prepopAbortRef.current = controller;
    setPrepopLoading(true);
    setPrepop(null);
    setPrepopFilledLinks({});
    try {
      const res = await fetch(apiUrl('/api/dtr/prepopulate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epicPatientId: requestPatientId, libraryId: 'MRIBrainPrepopulation' }),
        signal: controller.signal
      });
      const json = await res.json();
      if (prepopReqRef.current !== myReq) {
        // Context changed while we were awaiting -- either the user
        // switched Epic patients, switched scenarios, or re-signed a
        // different order. Discard the result rather than write it
        // into a now-unrelated context.
        return;
      }
      setPrepop({ ok: res.ok, status: res.status, json });
      if (res.ok) {
        // Very light heuristic mapping: an item whose text (or linkId)
        // clearly names a demographic gets the matching CQL result. We do
        // not attempt to prefill clinical items -- those need real
        // questionnaire authoring and are out of scope for this pass.
        const results = json.results || {};
        const filled = {};
        for (const item of requestQuestionnaireItems) {
          const key = `${item.linkId} ${item.text || ''}`.toLowerCase();
          if (/given|first\s*name/.test(key) && results.PatientGivenName) {
            filled[item.linkId] = { define: 'PatientGivenName', value: results.PatientGivenName };
          } else if (/family|last\s*name|surname/.test(key) && results.PatientFamilyName) {
            filled[item.linkId] = { define: 'PatientFamilyName', value: results.PatientFamilyName };
          } else if (/birth|dob\b/.test(key) && results.PatientDOB) {
            filled[item.linkId] = { define: 'PatientDOB', value: results.PatientDOB };
          } else if (/gender|sex\b/.test(key) && results.PatientGender) {
            filled[item.linkId] = { define: 'PatientGender', value: results.PatientGender };
          }
        }
        // Functional update so a concurrent QuestionnaireItem onChange
        // typed while we were awaiting doesn't get silently overwritten.
        setAnswers((prev) => {
          const next = { ...prev };
          for (const [linkId, { value }] of Object.entries(filled)) {
            next[linkId] = value;
          }
          return next;
        });
        // Only the linkId -> define name mapping needs to persist for the badge.
        setPrepopFilledLinks(
          Object.fromEntries(Object.entries(filled).map(([k, v]) => [k, v.define]))
        );
      }
    } catch (e) {
      // AbortError means invalidatePrepop() cancelled us -- state is
      // already cleared by that helper, so drop through without
      // touching anything. For any other error, only surface it if
      // we're still the latest request (else it belongs to a
      // superseded call and would clobber the current one's state).
      if (e?.name === 'AbortError') return;
      if (prepopReqRef.current === myReq) {
        setPrepop({ ok: false, json: { error: e.message } });
      }
    } finally {
      // Release the abort controller slot if this request still owns
      // it (invalidatePrepop nulls it out on cancellation).
      if (prepopAbortRef.current === controller) {
        prepopAbortRef.current = null;
      }
      // Only clear loading if we're still the latest request; a newer
      // in-flight kickoff (or the identity-change effect / invalidate
      // path) will manage the flag itself, and clobbering it here
      // would mask that request's progress state.
      if (prepopReqRef.current === myReq) {
        setPrepopLoading(false);
      }
    }
  };

  const indicator = card?.indicator || 'info';
  const style = INDICATOR_STYLES[indicator] || INDICATOR_STYLES.info;
  const isHardStop = indicator === 'hard-stop';

  return (
    <div className="p-8 max-w-6xl mx-auto font-sans bg-gray-50 min-h-screen">
      <h1 className="text-3xl font-bold mb-6 text-blue-900">
        Provider EHR Workspace
      </h1>

      {/* ---- SMART launch: EHR launch CTA when no session active -------- */}
      {!launchedSession && (
        <div className="mb-6 max-w-3xl bg-slate-50 border border-slate-300 rounded-lg p-4 text-sm">
          <div className="text-xs uppercase tracking-widest text-slate-500 mb-1">
            SMART on FHIR — EHR launch
          </div>
          <div className="text-slate-800 mb-2">
            Launch this app the way a real EHR would, from the reference{' '}
            <a
              href="https://launch.smarthealthit.org"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold"
            >
              SMART App Launcher
            </a>{' '}
            — the same open-source launcher Epic and Cerner test against.
          </div>
          <ol className="list-decimal list-inside text-slate-700 space-y-1 mb-3">
            <li>Click <strong>Open SMART App Launcher</strong> below — this app&rsquo;s launch URL is already filled in, nothing to type</li>
            <li>Pick any provider and any patient on the launcher&rsquo;s own screens</li>
            <li>
              Click <strong>Launch</strong> — this app loads embedded inside the launcher&rsquo;s
              page (its &ldquo;simulate launch within the EHR UI&rdquo; mode), the way a real EHR
              would iframe a launched app rather than navigating away
            </li>
          </ol>
          <a
            href="https://launch.smarthealthit.org/?launch_url=https%3A%2F%2Fsurakshith.com%2Fcms-0057%2Fehr%2Flaunch&launch=WzAsIiIsIiIsIkFVVE8iLDAsMCwxLCIiLCIiLCIiLCIiLCIiLCIiLCIiLDAsMSwiIl0"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-xs px-3 py-1.5 rounded bg-slate-800 text-white hover:bg-slate-900"
          >
            Open SMART App Launcher →
          </a>
          <div className="text-xs text-slate-500 mt-2">
            The embedded app shows a banner naming the launched patient. Launched data is
            displayed for the current session only, never persisted. For real Epic sandbox
            identities via SMART Backend Services instead, click any Epic patient in the
            scenarios below.
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
              onClick={() => {
                // Only invalidate when the scenario is actually
                // changing. Re-clicking the already-active card
                // must not clear the prepop results panel / badges
                // (which would leave the questionnaire fields filled
                // with values that have no visible provenance).
                if (scenarioId !== s.id) invalidatePrepop();
                // Also supersede any in-flight fetchEpicTestPatient
                // -- otherwise its late resolution would call
                // setScenarioId('epic-patient') and revert this
                // deliberate non-Epic selection. The supersession
                // also means that fetch's finally won't clear
                // epicLoading (ref !== myReq), so clear it here or
                // every Epic sandbox button stays permanently
                // disabled until page reload.
                epicFetchReqRef.current += 1;
                setEpicLoading(false);
                setScenarioId(s.id);
              }}
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

        <div className="text-xs uppercase tracking-wide text-gray-500 mt-4 mb-2">
          Epic sandbox (real FHIR reads via SMART Backend Services)
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {EPIC_TEST_PATIENTS.map((p) => {
            const isActive = scenarioId === 'epic-patient' && epicPatientId === p.id;
            const isFetching = epicLoading && epicPatientId === p.id;
            return (
              <button
                key={p.id}
                onClick={() => fetchEpicTestPatient(p.id)}
                disabled={epicLoading}
                className={`text-left p-3 rounded-lg border-2 transition-all disabled:opacity-60 ${
                  isActive
                    ? 'border-sky-400 bg-white shadow-md'
                    : 'border-gray-200 bg-gray-50 hover:bg-white hover:border-gray-300'
                }`}
              >
                <div className="font-semibold text-gray-900 text-sm">{p.label}</div>
                <span className="inline-block text-xs px-1.5 py-0.5 rounded font-medium mt-1 bg-sky-100 text-sky-800">
                  Epic Sandbox
                </span>
                <div className="text-xs text-gray-500 mt-1 leading-snug">
                  {isFetching
                    ? 'Fetching real identity from Epic…'
                    : isActive
                      ? 'Active — real Epic FHIR identity'
                      : 'Click to fetch real identity'}
                </div>
              </button>
            );
          })}
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
        {scenarioId === 'epic-patient' && (
          <div className="text-xs text-sky-800 bg-sky-50 border border-sky-200 rounded px-2 py-1.5 mb-4">
            Real Epic FHIR identity. The coverage, member ID, and ordering
            NPI above are synthesized for this demo — Epic&rsquo;s sandbox
            has no BCBSIL coverage data.
          </div>
        )}
        <div className="mb-1 text-xs uppercase tracking-wide text-gray-500">Plan type</div>
        <select
          className="border border-gray-300 p-2 rounded w-full mb-4 text-gray-800"
          value={planType}
          onChange={(e) => { invalidateOrderContext(); setPlanType(e.target.value); }}
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
          onChange={(e) => { invalidateOrderContext(); setSelectedIndex(Number(e.target.value)); }}
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
            onChange={(e) => { invalidateOrderContext(); setCustomCode(e.target.value); }}
            placeholder="e.g. 27447, J9145, 99213"
            className="border border-gray-300 p-2 rounded flex-1 text-gray-800 font-mono"
          />
          {customCode && (
            <button
              type="button"
              onClick={() => { invalidateOrderContext(); setCustomCode(''); }}
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
            (structured reason codes, CMS-0057-F, 45 CFR 156.223)
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

      {/* ---- Pharmacy-benefit drug track (NCPDP) ------------------------- */}
      {pharmacyRun > 0 && order.siteOfCare === 'self' && (
        <PharmacyEpa
          key={pharmacyRun}
          drugKey={order.drug}
          patientId={buildPatientResource(scenario, order.conditions).id}
          prescriberNpi={scenario.npi}
        />
      )}

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
                    disabled={loading}
                    className="bg-indigo-600 text-white px-5 py-2.5 rounded font-bold hover:bg-indigo-700 shadow flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
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

      {/* ---- Optum Real Prior Auth: second independent CRD opinion ----- */}
      {(optumOrderSignLoading || optumOrderSign) && (
        <div className="bg-violet-50 border-2 border-violet-600 text-violet-900 px-6 py-4 rounded-lg shadow-sm mb-6 max-w-3xl">
          <div className="text-xs uppercase tracking-widest text-violet-700 mb-1">
            Optum Real Prior Authorization (second CRD opinion)
          </div>
          {optumOrderSignLoading && !optumOrderSign ? (
            <div className="text-sm">Checking with UnitedHealthcare&rsquo;s real CRD engine...</div>
          ) : optumOrderSign?.ok ? (
            <>
              <div className="text-sm">
                {optumOrderSign.json?.cards?.cards?.length || 0} card(s) returned · Mode:{' '}
                <code className="bg-white px-1 rounded">{optumOrderSign.json?.mode}</code>
              </div>
              <div className="mt-2 space-y-1.5">
                {(optumOrderSign.json?.cards?.cards || []).map((c, i) => (
                  <div key={i} className="text-xs bg-white border border-violet-200 rounded px-2 py-1.5">
                    <span className="font-bold uppercase text-violet-700">{c.indicator}</span>{' '}
                    <span className="font-semibold">{c.summary}</span>
                    {c.detail && <div className="text-violet-800 mt-0.5">{c.detail}</div>}
                    {c.source?.label && (
                      <div className="text-violet-500 mt-0.5">Source: {c.source.label}</div>
                    )}
                  </div>
                ))}
              </div>
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-violet-700">Show CDS Hooks request/response JSON</summary>
                <pre className="bg-white p-2 rounded mt-1 overflow-x-auto text-[10px]">
                  {JSON.stringify(optumOrderSign.json, null, 2)}
                </pre>
              </details>
            </>
          ) : (
            <div className="text-sm">
              Optum call failed: {optumOrderSign?.json?.error || `HTTP ${optumOrderSign?.status}`}
            </div>
          )}
        </div>
      )}

      {/* ---- Availity coverage check (X12 270/271 eligibility) ---------- */}
      {(availityLoading || availityResult) && (
        <div className="bg-sky-50 border-2 border-sky-600 text-sky-900 px-6 py-4 rounded-lg shadow-sm mb-6 max-w-3xl">
          <div className="text-xs uppercase tracking-widest text-sky-700 mb-1">
            Availity coverage check (X12 270/271 eligibility)
          </div>
          {availityLoading && !availityResult ? (
            <div className="text-sm">Checking eligibility with Availity&hellip;</div>
          ) : availityResult?.ok ? (
            (() => {
              const first = availityResult.json?.response?.coverages?.[0];
              const plan = first?.plans?.[0];
              const active = /active/i.test(plan?.status || '');
              return (
                <>
                  <div className="font-bold">
                    {active ? '✓' : '⚠'} {plan?.status || first?.status || 'Response received'}
                  </div>
                  <div className="text-sm mt-1">
                    Payer:{' '}
                    <code className="bg-white px-1 rounded">
                      {first?.payer?.name || first?.payer?.payerId || '—'}
                    </code>{' '}
                    · Member:{' '}
                    <code className="bg-white px-1 rounded">
                      {first?.subscriber?.memberId || '—'}
                    </code>{' '}
                    · Mode:{' '}
                    <code className="bg-white px-1 rounded">{availityResult.json?.mode}</code>
                  </div>
                  {availityResult.json?.response?._mock && (
                    <div className="text-xs mt-2 text-sky-800 bg-sky-100 px-2 py-1 rounded">
                      Mock response. Set AVAILITY_CLIENT_ID and AVAILITY_CLIENT_SECRET on
                      Cloud Run to route to the real Availity Coverages API.
                    </div>
                  )}
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-sky-700">Show request/response JSON</summary>
                    <pre className="bg-white p-2 rounded mt-1 overflow-x-auto text-[10px]">
                      {JSON.stringify(availityResult.json, null, 2)}
                    </pre>
                  </details>
                </>
              );
            })()
          ) : (
            <div className="text-sm">
              Availity call failed: {availityResult?.json?.error || `HTTP ${availityResult?.status}`}
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

            {scenarioId === 'epic-patient' && (
              <div className="mb-5 bg-teal-50 border border-teal-300 rounded-lg p-4">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <div className="text-xs uppercase tracking-widest text-teal-700 font-semibold">
                      DTR pre-population via CQL against Epic FHIR
                    </div>
                    <div className="text-xs text-teal-800 mt-1">
                      Runs the <code className="bg-white px-1 rounded">MRIBrainPrepopulation</code> ELM library against a Patient + Condition + Observation Bundle fetched from Epic (real live in production if scopes are granted, canned in mock modes). Demographic defines are auto-mapped to matching questionnaire items; the clinical define is shown below.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={runCqlPrepop}
                    disabled={prepopLoading}
                    className="bg-teal-700 hover:bg-teal-600 disabled:opacity-50 text-white text-sm font-semibold px-3 py-1.5 rounded shrink-0 ml-2"
                  >
                    {prepopLoading ? 'Evaluating…' : 'Pre-populate from Epic via CQL'}
                  </button>
                </div>
                {prepop && (
                  prepop.ok ? (
                    <div className="mt-2 text-xs">
                      <div className="text-teal-700 mb-2">
                        mode <span className="font-mono">{prepop.json.mode}</span> · library <span className="font-mono">{prepop.json.libraryId}</span> · pulled {prepop.json.bundleSummary?.totalEntries || 0} resource{prepop.json.bundleSummary?.totalEntries === 1 ? '' : 's'} from Epic
                        {prepop.json.bundleSummary?.byResourceType && (
                          <span className="ml-1">({Object.entries(prepop.json.bundleSummary.byResourceType).map(([k, v]) => `${v} ${k}`).join(', ')})</span>
                        )}
                      </div>
                      <table className="w-full text-xs bg-white rounded border border-teal-200">
                        <thead className="bg-teal-100 text-teal-800">
                          <tr>
                            <th className="text-left px-2 py-1">CQL define</th>
                            <th className="text-left px-2 py-1">Evaluated value</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(prepop.json.results || {}).map(([k, v]) => (
                            <tr key={k} className="border-t border-teal-100">
                              <td className="px-2 py-1 font-mono text-teal-900">{k}</td>
                              <td className="px-2 py-1 text-gray-800">
                                {typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v ?? '')}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {Object.keys(prepopFilledLinks).length > 0 ? (
                        <div className="mt-2 text-teal-700">
                          Auto-populated {Object.keys(prepopFilledLinks).length} questionnaire item{Object.keys(prepopFilledLinks).length === 1 ? '' : 's'} below.
                        </div>
                      ) : (
                        <div className="mt-2 text-gray-600">
                          No demographic items in this questionnaire matched the heuristic; the CQL results above are informational only. A questionnaire with items labeled &ldquo;first name&rdquo; / &ldquo;family name&rdquo; / &ldquo;birth date&rdquo; / &ldquo;gender&rdquo; would prefill from the values above.
                        </div>
                      )}
                      {(prepop.json.warnings || []).length > 0 && (
                        <div className="mt-2 text-amber-700">
                          Epic returned partial data: {prepop.json.warnings.map((w) => `${w.resourceType} (HTTP ${w.status})`).join(', ')}. Non-fetched types evaluate to no-match in the CQL results above.
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="mt-2 text-xs text-red-700">
                      Error: {prepop.json?.error || `HTTP ${prepop.status}`}
                    </div>
                  )
                )}
              </div>
            )}

            {drugPrefillFrom === 'pharmacy' && (
              <div className="text-xs bg-emerald-100 border border-emerald-300 text-emerald-900 rounded px-2 py-1 mb-3">
                Answers carried over from the pharmacy-benefit (NCPDP) request on the shared drug PA record. Nothing re-entered.
              </div>
            )}
            <form onSubmit={submitPas} className="space-y-5">
              {(questionnaire.item || []).map((item) => (
                <QuestionnaireItem
                  key={item.linkId}
                  item={item}
                  value={answers[item.linkId]}
                  onChange={(v) =>
                    setAnswers((prev) => ({ ...prev, [item.linkId]: v }))
                  }
                  cqlPrefillDefine={prepopFilledLinks[item.linkId]}
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

      {/* ---- Optum Real DTR: reference questionnaire ------------------- */}
      {showDtr && (optumQuestionnaireLoading || optumQuestionnaire) && (
        <div className="bg-violet-50 border-2 border-violet-600 text-violet-900 px-6 py-4 rounded-lg shadow-sm mt-4 max-w-3xl">
          <div className="text-xs uppercase tracking-widest text-violet-700 mb-1">
            Optum Real DTR (reference questionnaire, informational only)
          </div>
          {optumQuestionnaireLoading && !optumQuestionnaire ? (
            <div className="text-sm">Retrieving a real DTR questionnaire package from Optum...</div>
          ) : optumQuestionnaire?.ok ? (
            (() => {
              const q =
                optumQuestionnaire.json?.response?.parameter?.[0]?.resource?.entry?.[0]?.resource;
              return (
                <>
                  <div className="text-sm font-bold">{q?.title || 'Questionnaire retrieved'}</div>
                  <div className="text-xs mt-1 text-violet-700">
                    Mode: <code className="bg-white px-1 rounded">{optumQuestionnaire.json?.mode}</code>
                    {q?.publisher && <> · Publisher: {q.publisher}</>}
                  </div>
                  {q?.description && (
                    <div className="text-xs mt-2 text-violet-800">{q.description}</div>
                  )}
                  {(q?.item || []).length > 0 && (
                    <ul className="text-xs mt-2 space-y-1 list-disc list-inside">
                      {q.item.slice(0, 6).map((it) => (
                        <li key={it.linkId} className="text-violet-800">
                          {it.text}{' '}
                          <span className="text-violet-400">({it.type}{it.required ? ', required' : ''})</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-violet-700">Show full response JSON</summary>
                    <pre className="bg-white p-2 rounded mt-1 overflow-x-auto text-[10px]">
                      {JSON.stringify(optumQuestionnaire.json, null, 2)}
                    </pre>
                  </details>
                </>
              );
            })()
          ) : (
            <div className="text-sm">
              Optum call failed: {optumQuestionnaire?.json?.error || `HTTP ${optumQuestionnaire?.status}`}
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

      {pasResponse && !pendedId && pasReview?.actionCode === 'A3' && (
        <div className="bg-red-50 border-2 border-red-700 text-red-900 px-6 py-4 rounded-lg shadow-sm mt-6 max-w-3xl">
          <div className="font-bold text-lg mb-2">✗ {pasResponse.disposition}</div>
          <div className="mb-2">
            <div className="text-sm font-semibold">
              Review action:{' '}
              <code className="bg-white px-1 rounded text-red-800">{pasReview.actionCode}</code>{' '}
              <span className="font-normal">— {pasReview.actionDisplay} (X12 306)</span>
            </div>
            {pasReview.reasonCode && (
              <div className="text-sm font-semibold">
                Reason code:{' '}
                <code className="bg-white px-1 rounded text-red-800">{pasReview.reasonCode}</code>{' '}
                <span className="font-normal">— {pasReview.reasonDisplay} (X12 886)</span>
              </div>
            )}
            {pasReview.reasonText && (
              <div className="text-sm mt-1 text-red-800 italic">&ldquo;{pasReview.reasonText}&rdquo;</div>
            )}
          </div>
          <div className="text-xs mt-3 text-red-700 bg-red-100 px-2 py-1 rounded font-mono">
            Structured denial reason required per CMS-0057-F (effective Jan 1, 2026). Appeal rights apply.
          </div>
        </div>
      )}

      {pasResponse && !pendedId && pasResponse.outcome === 'error' && (
        <div className="bg-red-50 border-2 border-red-700 text-red-900 px-6 py-4 rounded-lg shadow-sm mt-6 max-w-3xl">
          <div className="font-bold text-lg mb-2">✗ Request rejected before adjudication</div>
          {(pasResponse.error || []).map((err, i) => {
            const coding = err.code?.coding?.[0];
            return (
              <div key={i} className="text-sm">
                Reject reason:{' '}
                <code className="bg-white px-1 rounded text-red-800">{coding?.code}</code>{' '}
                <span className="font-normal">— {coding?.display} (X12 901)</span>
                {err.code?.text && <div className="text-sm mt-1 text-red-800 italic">{err.code.text}</div>}
              </div>
            );
          })}
        </div>
      )}

      {pasResponse && !pendedId && pasReview?.actionCode === 'A1' && (
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

      {pasResponse && !pendedId && drugRecord && (
        <div className="max-w-3xl mt-2">
          <SharedRecord record={drugRecord} />
        </div>
      )}

      {/* Optum Real Prior Auth parallel path (Claim/$submit) --------------- */}
      {(optumPasLoading || optumPasResult) && (
        <div className="bg-violet-50 border-2 border-violet-600 text-violet-900 px-6 py-4 rounded-lg shadow-sm mt-4 max-w-3xl">
          <div className="text-xs uppercase tracking-widest text-violet-700 mb-1">
            Optum Real Prior Authorization (parallel PAS path)
          </div>
          {optumPasLoading && !optumPasResult ? (
            <div className="text-sm">Submitting to Optum&rsquo;s real Claim/$submit endpoint...</div>
          ) : optumPasResult?.ok ? (
            (() => {
              const cr = optumPasResult.json?.response?.entry?.[0]?.resource;
              return (
                <>
                  <div className="font-bold">
                    {cr?.outcome === 'queued' ? '⏳' : '✓'} {cr?.disposition || cr?.outcome || 'Response received'}
                  </div>
                  <div className="text-sm mt-1">
                    Outcome: <code className="bg-white px-1 rounded">{cr?.outcome || '—'}</code> · Mode:{' '}
                    <code className="bg-white px-1 rounded">{optumPasResult.json?.mode}</code>
                  </div>
                  <div className="text-xs mt-2 text-violet-800 bg-violet-100 px-2 py-1 rounded">
                    From a real, independent UnitedHealthcare-shaped Da Vinci PAS implementation —
                    a genuine second opinion on the same Bundle, not just a projection of this
                    sandbox&rsquo;s own decision.
                  </div>
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-violet-700">Show request/response JSON</summary>
                    <pre className="bg-white p-2 rounded mt-1 overflow-x-auto text-[10px]">
                      {JSON.stringify(optumPasResult.json, null, 2)}
                    </pre>
                  </details>
                </>
              );
            })()
          ) : (
            <div className="text-sm">
              Optum call failed: {optumPasResult?.json?.error || `HTTP ${optumPasResult?.status}`}
            </div>
          )}
        </div>
      )}

      {/* Epic Backend Services panel ----------------------------------- */}
      <div id="epic-backend-services" className="bg-sky-50 border-2 border-sky-600 text-sky-900 px-6 py-4 rounded-lg shadow-sm mt-4 max-w-3xl">
        <div className="text-xs uppercase tracking-widest text-sky-700 mb-1">
          Epic Backend Services (SMART client-confidential-asymmetric)
        </div>
        <p className="text-sm text-sky-800 mb-3">
          In production, DTR pre-population pulls clinical context from the
          provider&rsquo;s EHR. Clicking a name under &ldquo;Epic sandbox&rdquo; above
          performs that call for real against Epic&rsquo;s public FHIR sandbox, using
          SMART Backend Services (RS384-signed client assertion, published JWKS).
        </p>

        {epicError && (
          <div className="text-sm text-red-700">Epic call failed: {epicError}</div>
        )}

        {!epicError && !epicResult && (
          <div className="text-sm text-sky-700">
            Click an Epic sandbox patient above to fetch their real record here.
          </div>
        )}

        {epicResult?.patient && (
          <div className="text-sm">
            <div className="flex items-center gap-2">
              <strong>{epicPatientDisplayName(epicResult.patient) || '(no name returned)'}</strong>
              {epicResult.mode && (
                <span className="text-xs font-mono px-2 py-0.5 rounded bg-sky-100 text-sky-800 border border-sky-200">
                  mode: {epicResult.mode}
                </span>
              )}
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
function QuestionnaireItem({ item, value, onChange, cqlPrefillDefine }) {
  const hasCqlPrePop = !!item.extension?.find((e) =>
    (e.url || '').includes('initialExpression')
  );

  const labelBlock = (
    <label className="block mb-2 font-medium text-gray-800">
      {item.text}
      {item.required && <span className="text-red-600 ml-1">*</span>}
    </label>
  );

  const badge = (hasCqlPrePop || cqlPrefillDefine) && (
    <div className="flex items-center gap-2 text-sm mb-2 flex-wrap">
      {hasCqlPrePop && (
        <span className="bg-green-100 text-green-800 px-2 py-0.5 rounded text-xs font-semibold border border-green-200">
          Auto-populated via CQL ({item.extension.find((e) => (e.url || '').includes('initialExpression')).valueExpression.expression})
        </span>
      )}
      {cqlPrefillDefine && (
        <span className="bg-teal-100 text-teal-800 px-2 py-0.5 rounded text-xs font-semibold border border-teal-300">
          Prefilled from live CQL: {cqlPrefillDefine}
        </span>
      )}
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
