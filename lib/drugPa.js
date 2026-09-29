/**
 * Drug prior authorization: one decision model shared by both benefit
 * tracks (CMS-0062-P position 2).
 *
 *   clinic-administered → medical benefit  → CRD → DTR → PAS (HCPCS)
 *   self-administered   → pharmacy benefit → RTPB → F&B → NCPDP SCRIPT ePA (NDC)
 *
 * Both tracks ask the same questions, decide with the same function, and
 * report the same coded reason. The DTR Questionnaire and the NCPDP
 * question set are both generated from DRUG_CATALOG[*].questions, so a
 * drug that moves between benefits is not re-asked.
 *
 * Pure data and functions (no fs), so client components can import it.
 *
 * Drug identifiers were checked against NLM RxNav on 2026-09-28. The
 * medical-benefit rule is the real BCBSIL grid row for J0717 (2026
 * commercial specialty pharmacy PA list, page 6), whose text reads "not
 * for use when drug is self administered". The clinical criteria below
 * are illustrative, not BCBSIL policy.
 */
import { REVIEW_REASONS } from './fhir';

export const DRUG_CATALOG = {
  certolizumab: {
    key: 'certolizumab',
    name: 'Certolizumab pegol (Cimzia)',
    rxnormIngredient: '709271',
    siteOfCare: {
      clinic: {
        benefit: 'medical',
        label: 'Clinic-administered, 200 mg lyophilized powder',
        hcpcs: 'J0717',
        rxcui: '795085',
        ndc: '50474070062',
        // Illustrative authorized quantity per request.
        quantity: { value: 400, unit: 'mg' }
      },
      self: {
        benefit: 'pharmacy',
        label: 'Self-administered, 200 mg/mL prefilled syringe',
        rxcui: '849599',
        ndc: '50474075010',
        // Illustrative: two 200 mg syringes per 28 days.
        quantity: { value: 2, unit: 'syringe' }
      }
    },
    questionnaireId: 'drug-certolizumab',
    questions: [
      {
        linkId: 'diagnosis',
        text: 'Diagnosis',
        type: 'choice',
        options: [
          { code: 'M05.79', display: 'Rheumatoid arthritis with rheumatoid factor of multiple sites' },
          { code: 'K50.90', display: "Crohn's disease, unspecified, without complications" }
        ]
      },
      {
        linkId: 'conventional-therapy-failed',
        text: 'Tried and failed a conventional therapy (for example methotrexate) for at least 3 months',
        type: 'boolean'
      },
      {
        linkId: 'tb-screen-negative',
        text: 'Negative tuberculosis screening within the last 12 months',
        type: 'boolean'
      }
    ]
  }
};

export const DRUG_BY_HCPCS = { J0717: 'certolizumab' };

/**
 * One reason list for both tracks. `x12` is the X12 886 code carried in the
 * PAS and PDex reviewAction. `carc` is the X12 Claim Adjustment Reason Code
 * the PDex Prior Authorization EOB requires in its denialreason adjudication
 * slice (required binding to CARC/RARC). The NCPDP PAResponse carries the
 * same key and text.
 * NCPDP's own denial reason code list is licensed and is not reproduced.
 */
export const DRUG_DENIAL_REASONS = {
  'step-therapy': {
    text: 'Step therapy not met: no documented trial and failure of a conventional therapy for at least 3 months',
    x12: REVIEW_REASONS.conservativeTreatmentFailure,
    carc: { code: '50', display: "These are non-covered services because this is not deemed a 'medical necessity' by the payer." }
  },
  'tb-screen': {
    text: 'A negative tuberculosis screening within the last 12 months is required',
    x12: REVIEW_REASONS.additionalInfoRequired,
    carc: { code: '16', display: 'Claim/service lacks information or has submission/billing error(s).' }
  }
};

/**
 * The shared decision. `answers` is { linkId: value }. Returns
 * { determination: 'approved' | 'denied', reasonKey }.
 */
export function decideDrugPa(drugKey, answers = {}) {
  if (!DRUG_CATALOG[drugKey]) throw new Error(`Unknown drug ${drugKey}`);
  if (answers['conventional-therapy-failed'] !== true) {
    return { determination: 'denied', reasonKey: 'step-therapy' };
  }
  if (answers['tb-screen-negative'] !== true) {
    return { determination: 'denied', reasonKey: 'tb-screen' };
  }
  return { determination: 'approved', reasonKey: null };
}

/** FHIR R4 Questionnaire for the medical (DTR) track. */
export function drugQuestionnaire(drugKey) {
  const drug = DRUG_CATALOG[drugKey];
  if (!drug) return null;
  return {
    resourceType: 'Questionnaire',
    id: drug.questionnaireId,
    url: `http://payer.bcbsil.example/Questionnaire/${drug.questionnaireId}`,
    version: '1.0.0',
    name: `DrugPa${drugKey[0].toUpperCase()}${drugKey.slice(1)}`,
    title: `${drug.name}: prior authorization criteria`,
    status: 'active',
    subjectType: ['Patient'],
    publisher: 'BCBSIL UM (sandbox)',
    item: drug.questions.map((q) => ({
      linkId: q.linkId,
      text: q.text,
      type: q.type,
      // The DTR form renders booleans as checkboxes, where `required` would
      // force "Yes". An unchecked box is a "No" answer.
      required: q.type !== 'boolean',
      ...(q.options
        ? { answerOption: q.options.map((o) => ({ valueCoding: { system: 'http://hl7.org/fhir/sid/icd-10-cm', ...o } })) }
        : {})
    }))
  };
}

export function questionnaireIdForDrug(drugKey) {
  return DRUG_CATALOG[drugKey]?.questionnaireId || null;
}

export function drugKeyForQuestionnaire(id) {
  return Object.values(DRUG_CATALOG).find((d) => d.questionnaireId === id)?.key || null;
}

/** { linkId: value } from a QuestionnaireResponse. */
/**
 * Keep only answers to this drug's own questions, as booleans or short
 * codes. Answers are stored on the shared record and put in NCPDP
 * messages, so anything else is dropped.
 */
export function sanitizeDrugAnswers(drugKey, answers) {
  const drug = Object.hasOwn(DRUG_CATALOG, drugKey) ? DRUG_CATALOG[drugKey] : null;
  const ids = new Set((drug?.questions || []).map((q) => q.linkId));
  const out = {};
  for (const [k, v] of Object.entries(answers && typeof answers === 'object' ? answers : {})) {
    if (!ids.has(k)) continue;
    if (typeof v === 'boolean' || (typeof v === 'string' && v.length <= 32)) out[k] = v;
  }
  return out;
}

export function answersFromQuestionnaireResponse(qr) {
  const out = {};
  for (const item of Array.isArray(qr?.item) ? qr.item : []) {
    if (!item || typeof item.linkId !== 'string') continue;
    const a = Array.isArray(item.answer) ? item.answer[0] : null;
    if (!a || typeof a !== 'object') continue;
    if ('valueBoolean' in a) out[item.linkId] = a.valueBoolean;
    else if (a.valueCoding) out[item.linkId] = a.valueCoding.code;
    else if ('valueString' in a) out[item.linkId] = a.valueString;
  }
  return out;
}
