/**
 * Da Vinci PAS profile constants and response envelope.
 *
 * Canonical URLs verified against the published PAS IG (v2.2.1, STU 2).
 * profile-pas-response-bundle fixes Bundle.type to `collection` — PAS
 * mirrors the X12 278 request/response model rather than FHIR transaction
 * semantics, so `collection` (not `transaction-response`) is the conformant
 * type for both request and response bundles.
 */

export const PAS_PROFILES = {
  requestBundle:
    'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-pas-request-bundle',
  responseBundle:
    'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-pas-response-bundle',
  claim: 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-claim',
  claimResponse:
    'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-claimresponse'
};

/**
 * PAS review action (extension-reviewAction), the coded determination on
 * ClaimResponse.item.adjudication / addItem.adjudication. The action code
 * is X12 Code Source 306 (HCR01) and the reason code is X12 External Code
 * Source 886 (HCR03), matching the X12 278 HCR segment.
 */
export const X12_ACTION_SYSTEM = 'https://codesystem.x12.org/005010/306';
export const X12_REASON_SYSTEM = 'https://codesystem.x12.org/external/886';
const REVIEW_ACTION_URL =
  'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/extension-reviewAction';
const REVIEW_ACTION_CODE_URL =
  'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/extension-reviewActionCode';
const ADJUDICATION_SYSTEM = 'http://terminology.hl7.org/CodeSystem/adjudication';

export const REVIEW_ACTIONS = {
  certified: { code: 'A1', display: 'Certified in total' },
  notCertified: { code: 'A3', display: 'Not Certified' },
  pended: { code: 'A4', display: 'Pending' }
};

export const REVIEW_REASONS = {
  notMedicallyNecessary: { code: '0F', display: 'Not Medically Necessary' },
  additionalInfoRequired: { code: '0U', display: 'Additional Patient Information required' },
  conservativeTreatmentFailure: {
    code: '44',
    display: 'Documentation of conservative treatment failure is required'
  }
};

export function reviewActionExtension({ action, number, reason, reasonText }) {
  const extension = [
    {
      url: REVIEW_ACTION_CODE_URL,
      valueCodeableConcept: {
        coding: [{ system: X12_ACTION_SYSTEM, code: action.code, display: action.display }]
      }
    }
  ];
  if (number) extension.push({ url: 'number', valueString: number });
  if (reason) {
    extension.push({
      url: 'reasonCode',
      valueCodeableConcept: {
        coding: [{ system: X12_REASON_SYSTEM, code: reason.code, display: reason.display }],
        ...(reasonText ? { text: reasonText } : {})
      }
    });
  }
  return { url: REVIEW_ACTION_URL, extension };
}

/**
 * One adjudication entry carrying the review action. `submitted` is the
 * category the PAS examples use for the determination.
 */
export function reviewAdjudication(review) {
  return {
    category: { coding: [{ system: ADJUDICATION_SYSTEM, code: 'submitted' }] },
    extension: [reviewActionExtension(review)]
  };
}

/**
 * ClaimResponse.item[] echoing each Claim.item.sequence, every line
 * carrying the same determination. Falls back to one line when the Claim
 * has no items.
 */
export function claimResponseItems(claim, review) {
  const sequences = (claim?.item || []).map((it, i) => it.sequence || i + 1);
  return (sequences.length ? sequences : [1]).map((itemSequence) => ({
    itemSequence,
    adjudication: [reviewAdjudication(review)]
  }));
}

/**
 * Read the first review action from a ClaimResponse, looking in
 * item[].adjudication, addItem[].adjudication, then adjudication.
 * Client-safe. Returns null when no review action is present.
 */
export function readReviewAction(claimResponse) {
  if (!claimResponse) return null;
  const adjudications = [
    ...(claimResponse.item || []).flatMap((it) => it.adjudication || []),
    ...(claimResponse.addItem || []).flatMap((it) => it.adjudication || []),
    ...(claimResponse.adjudication || [])
  ];
  for (const adj of adjudications) {
    const ext = (adj.extension || []).find((e) => e.url === REVIEW_ACTION_URL);
    if (!ext) continue;
    const sub = (url) => ext.extension?.find((e) => e.url === url);
    const action = sub(REVIEW_ACTION_CODE_URL)?.valueCodeableConcept?.coding?.[0];
    if (!action?.code) continue;
    const reason = sub('reasonCode')?.valueCodeableConcept;
    return {
      actionCode: action?.code || null,
      actionDisplay: action?.display || null,
      number: sub('number')?.valueString || null,
      reasonCode: reason?.coding?.[0]?.code || null,
      reasonDisplay: reason?.coding?.[0]?.display || null,
      reasonText: reason?.text || null
    };
  }
  return null;
}

/**
 * Validation errors (request could not be adjudicated). X12 Code Source 901
 * is the AAA03 reject reason and 889 is the AAA04 follow-up action. PAS
 * carries the follow-up action in extension-errorFollowupAction.
 */
const X12_REJECT_SYSTEM = 'https://codesystem.x12.org/005010/901';
const X12_FOLLOWUP_SYSTEM = 'https://codesystem.x12.org/005010/889';
const ERROR_FOLLOWUP_URL =
  'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/extension-errorFollowupAction';

export const X12_REJECT_REASONS = {
  requiredDataMissing: { code: '15', display: 'Required application data missing' }
};

export function pasErrorClaimResponse({ patientId, insurer, reason, text }) {
  return {
    resourceType: 'ClaimResponse',
    id: `cr-${Date.now()}`,
    meta: { profile: [PAS_PROFILES.claimResponse] },
    status: 'active',
    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'institutional' }] },
    use: 'preauthorization',
    patient: { reference: `Patient/${patientId}` },
    created: new Date().toISOString(),
    insurer: { display: insurer },
    outcome: 'error',
    disposition: text,
    error: [
      {
        extension: [
          {
            url: ERROR_FOLLOWUP_URL,
            valueCodeableConcept: {
              coding: [{ system: X12_FOLLOWUP_SYSTEM, code: 'C', display: 'Please Correct and Resubmit' }]
            }
          }
        ],
        code: {
          coding: [{ system: X12_REJECT_SYSTEM, code: reason.code, display: reason.display }],
          text
        }
      }
    ]
  };
}

/**
 * Wrap PAS response resources (ClaimResponse first, plus the
 * coverage-information Task when one is emitted) in the profile-conformant
 * response Bundle.
 */
export function wrapPasResponseBundle(resources) {
  return {
    resourceType: 'Bundle',
    id: `pas-response-${Date.now()}`,
    meta: { profile: [PAS_PROFILES.responseBundle] },
    type: 'collection',
    timestamp: new Date().toISOString(),
    entry: resources.filter(Boolean).map((resource) => ({
      fullUrl: `urn:uuid:${crypto.randomUUID()}`,
      resource
    }))
  };
}
