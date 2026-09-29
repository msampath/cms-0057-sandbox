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
 * Implementation guide versions.
 *
 *   sandbox  → the version this sandbox's resources are shaped to (null
 *              where it does not implement the IG to a specific version)
 *   current  → the version in 45 CFR 170.215 today (eCFR, checked 2026-09-28)
 *   proposed → the version CMS-0062-P proposes to add (91 FR 19890, Table 12)
 *
 * CMS-0062-P lets payers use any unexpired version and proposes that the
 * versions it replaces expire on January 1, 2028 (preamble II.J.7).
 */
export const IG_REGISTRY = [
  {
    key: 'crd',
    name: 'Da Vinci CRD',
    canonical: 'http://hl7.org/fhir/us/davinci-crd/ImplementationGuide/hl7.fhir.us.davinci-crd',
    sandbox: '2.2.1',
    current: { version: '2.0.1', cfr: '170.215(j)(1)(i)' },
    proposed: { version: '2.2.1', cfr: '170.215(j)(1)(ii)' }
  },
  {
    key: 'dtr',
    name: 'Da Vinci DTR',
    canonical: 'http://hl7.org/fhir/us/davinci-dtr/ImplementationGuide/hl7.fhir.us.davinci-dtr',
    sandbox: null,
    current: { version: '2.0.1', cfr: '170.215(j)(2)(i)' },
    proposed: { version: '2.2.0', cfr: '170.215(j)(2)(ii)' }
  },
  {
    key: 'pas',
    name: 'Da Vinci PAS',
    canonical: 'http://hl7.org/fhir/us/davinci-pas/ImplementationGuide/hl7.fhir.us.davinci-pas',
    sandbox: '2.2.1',
    current: { version: '2.0.1', cfr: '170.215(j)(3)(i)' },
    proposed: { version: '2.2.1', cfr: '170.215(j)(3)(ii)' }
  },
  {
    key: 'cdex',
    name: 'Da Vinci CDex',
    canonical: 'http://hl7.org/fhir/us/davinci-cdex/ImplementationGuide/hl7.fhir.us.davinci-cdex',
    sandbox: null,
    current: null,
    proposed: { version: '2.1.0', cfr: '170.215(k)(3)' }
  },
  {
    key: 'pdex',
    name: 'Da Vinci PDex',
    canonical: 'http://hl7.org/fhir/us/davinci-pdex/ImplementationGuide/hl7.fhir.us.davinci-pdex',
    sandbox: '2.0.0',
    current: { version: '2.1.0', cfr: '170.215(k)(2)(i)' },
    proposed: null
  },
  {
    key: 'carin-bb',
    name: 'CARIN Blue Button',
    canonical: 'http://hl7.org/fhir/us/carin-bb/ImplementationGuide/hl7.fhir.us.carin-bb',
    sandbox: '2.2.0',
    current: { version: '2.0.0', cfr: '170.215(k)(1)(i)' },
    proposed: { version: '2.2.0', cfr: '170.215(k)(1)(ii)' }
  },
  {
    key: 'us-core',
    name: 'US Core',
    canonical: 'http://hl7.org/fhir/us/core/ImplementationGuide/hl7.fhir.us.core',
    // Moved from 3.1.1, which expired on January 1, 2026 (Phase 7).
    sandbox: '6.1.0',
    current: { version: '6.1.0', cfr: '170.215(b)(1)(ii)', expired: { version: '3.1.1', on: '2026-01-01' } },
    proposed: null
  }
];

export const PRIOR_VERSION_EXPIRY = '2028-01-01';

/**
 * Canonical with a `|version` suffix when the sandbox implements a version.
 * An expired version is never advertised: if the sandbox's version is the
 * registry's expired one, the canonical stays unversioned.
 */
export function versionedCanonical(url, igKey) {
  const ig = IG_REGISTRY.find((g) => g.key === igKey);
  if (!ig?.sandbox || ig.current?.expired?.version === ig.sandbox) return url;
  return `${url}|${ig.sandbox}`;
}

/**
 * CMS-0062-P proposed dates (91 FR 19890). All are proposals and may change
 * in the final rule.
 */
export const CMS_0062_P_DATES = [
  {
    when: 'October 1, 2027',
    what: 'Drug prior authorization: NCPDP ePA for pharmacy-benefit drugs, medical-benefit drugs in the Prior Authorization API, drug PA data in the Patient Access, Provider Access, and Payer-to-Payer APIs'
  },
  {
    when: 'January 1, 2028',
    what: 'Versions of 45 CFR 170.215 standards replaced by this rule expire'
  },
  {
    when: '2028',
    what: 'New prior authorization and drug prior authorization metrics reporting begins. FF-SHOP issuers are covered for plan years on or after January 1, 2028'
  },
  {
    when: '24 months after the final rule takes effect (36 for small health plans)',
    what: 'FHIR PAS replaces X12 278 as the HIPAA referral certification and authorization standard (proposed 45 CFR 162.1302)'
  }
];

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
