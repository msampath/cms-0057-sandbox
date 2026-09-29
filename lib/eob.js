/**
 * CARIN Blue Button (C4BB) ExplanationOfBenefit generator.
 *
 * Produces a minimal-but-credible Professional NonClinician EOB from one
 * summary row ({ date, description, amount, memberOOP }). Profile URL and
 * the total-slice category codes verified against the published CARIN BB
 * IG v2.2.0: totals are sliced by the C4BBAdjudication value set, which
 * combines the base adjudication CodeSystem (submitted) with the C4BB
 * CodeSystem (paidtoprovider, memberliability).
 *
 * Used by the Patient Access API (current-plan claims) and the
 * Payer-to-Payer history Bundle (prior-plan claims).
 */

export const CARIN_PROFILES = {
  eobProfessional:
    'http://hl7.org/fhir/us/carin-bb/StructureDefinition/C4BB-ExplanationOfBenefit-Professional-NonClinician',
  coverage: 'http://hl7.org/fhir/us/carin-bb/StructureDefinition/C4BB-Coverage'
};

export const US_CORE_PROFILES = {
  patient: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient'
};

const ADJUDICATION = 'http://terminology.hl7.org/CodeSystem/adjudication';
const C4BB_ADJUDICATION =
  'http://hl7.org/fhir/us/carin-bb/CodeSystem/C4BBAdjudication';
const CLAIM_TYPE = 'http://terminology.hl7.org/CodeSystem/claim-type';
const CPT = 'http://www.ama-assn.org/go/cpt';

function money(value) {
  return { value: Math.round(value * 100) / 100, currency: 'USD' };
}

/**
 * @param id           resource id (stable per row, e.g. eob-849-0)
 * @param patientId    demo patient id
 * @param patientName  display name
 * @param coverageRef  reference string to the Coverage the claim adjudicated under
 * @param payerDisplay insurer display name
 * @param row          { date, description, amount, memberOOP }
 * @param serviceCode  optional CPT/HCPCS code for item.productOrService
 */
export function buildEob({
  id,
  patientId,
  patientName,
  coverageRef,
  payerDisplay,
  row,
  serviceCode
}) {
  return {
    resourceType: 'ExplanationOfBenefit',
    id,
    meta: { profile: [CARIN_PROFILES.eobProfessional] },
    identifier: [
      { system: 'urn:payer:demo:eob-identifier', value: id }
    ],
    status: 'active',
    type: { coding: [{ system: CLAIM_TYPE, code: 'professional' }] },
    use: 'claim',
    patient: { reference: `Patient/${patientId}`, display: patientName },
    billablePeriod: { start: row.date, end: row.date },
    created: `${row.date}T12:00:00Z`,
    insurer: { display: payerDisplay },
    provider: { display: 'Contracted network provider (demo)' },
    outcome: 'complete',
    insurance: [{ focal: true, coverage: { reference: coverageRef } }],
    item: [
      {
        sequence: 1,
        productOrService: serviceCode
          ? {
              coding: [{ system: CPT, code: serviceCode }],
              text: row.description
            }
          : { text: row.description },
        servicedDate: row.date
      }
    ],
    total: [
      {
        category: {
          coding: [
            { system: ADJUDICATION, code: 'submitted', display: 'Submitted Amount' }
          ]
        },
        amount: money(row.amount)
      },
      {
        category: {
          coding: [
            {
              system: C4BB_ADJUDICATION,
              code: 'paidtoprovider',
              display: 'Paid to provider'
            }
          ]
        },
        amount: money(row.amount - row.memberOOP)
      },
      {
        category: {
          coding: [
            {
              system: C4BB_ADJUDICATION,
              code: 'memberliability',
              display: 'Member liability'
            }
          ]
        },
        amount: money(row.memberOOP)
      }
    ]
  };
}

// ---- PDex Prior Authorization EOB (drug PAs, CMS-0062-P) -------------------
//
// ExplanationOfBenefit (use: preauthorization) per the PDex Prior
// Authorization profile. Carries the decision in PDex's own
// extension-reviewAction (X12 306 action, X12 886 reason) and in the
// allowedunits / denialreason adjudication slices discriminated by
// PDexAdjudicationDiscriminator. The denialreason slice's reason is a CARC
// code, because the profile binds it (required) to CARC/RARC. Built from
// one track of a shared drug PA record (lib/db.js), so a drug decided on
// both benefits yields two EOBs with the same reason.
//
// Only the medical-benefit EOB claims the profile. The profile binds
// item.productOrService (required) to CPT, HCPCS, and HIPPS, so an
// NDC-coded pharmacy-benefit PA cannot conform, and this sandbox does not
// borrow J0717 for it (J0717 excludes self-administration). The pharmacy
// EOB keeps the same structure without the profile claim. That gap is a
// finding: the PDex PA profile does not yet fit pharmacy-benefit drug PAs.

export const PDEX_PROFILES = {
  priorAuthorization: 'http://hl7.org/fhir/us/davinci-pdex/StructureDefinition/pdex-priorauthorization'
};

const PDEX_REVIEW_ACTION = 'http://hl7.org/fhir/us/davinci-pdex/StructureDefinition/extension-reviewAction';
const PDEX_REVIEW_ACTION_CODE = 'http://hl7.org/fhir/us/davinci-pdex/StructureDefinition/extension-reviewActionCode';
const PDEX_DISCRIMINATOR = 'http://hl7.org/fhir/us/davinci-pdex/CodeSystem/PDexAdjudicationDiscriminator';
const X12_306 = 'https://codesystem.x12.org/005010/306';
const X12_886 = 'https://codesystem.x12.org/external/886';
const HCPCS = 'https://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets';
const NDC = 'http://hl7.org/fhir/sid/ndc';
const CARC = 'https://x12.org/codes/claim-adjustment-reason-codes';

/**
 * @param record   shared drug PA record { patientId, drugKey, determination, reasonKey, tracks }
 * @param track    'medical' | 'pharmacy'
 * @param drug     DRUG_CATALOG entry
 * @param reason   DRUG_DENIAL_REASONS entry or null
 * @param coverageRef, payerDisplay
 * @param practitionerRef reference to the prescriber, or null to use providerDisplay
 *                        (a display-only reference, for data from a prior payer)
 */
export function buildPriorAuthEob({ record, track, drug, reason, coverageRef, payerDisplay, practitionerRef, providerDisplay, providerNpi }) {
  const t = record.tracks[track];
  const form = track === 'medical' ? drug.siteOfCare.clinic : drug.siteOfCare.self;
  const approved = t.determination === 'approved';
  const authId = t.authNumber || t.caseId;
  const productOrService =
    track === 'medical'
      ? { coding: [{ system: HCPCS, code: form.hcpcs }], text: `${drug.name}, ${form.label}` }
      : { coding: [{ system: NDC, code: form.ndc }], text: `${drug.name}, ${form.label}` };

  const reviewAction = {
    url: PDEX_REVIEW_ACTION,
    extension: [
      {
        url: PDEX_REVIEW_ACTION_CODE,
        valueCodeableConcept: {
          coding: [{ system: X12_306, code: approved ? 'A1' : 'A3', display: approved ? 'Certified in total' : 'Not Certified' }]
        }
      },
      { url: 'number', valueString: authId },
      ...(reason
        ? [{ url: 'reasonCode', valueCodeableConcept: { coding: [{ system: X12_886, code: reason.x12.code, display: reason.x12.display }], text: reason.text } }]
        : [])
    ]
  };

  const adjudication = approved
    ? [{ extension: [reviewAction], category: { coding: [{ system: PDEX_DISCRIMINATOR, code: 'allowedunits' }] }, value: form.quantity.value }]
    : [{
        extension: [reviewAction],
        category: { coding: [{ system: PDEX_DISCRIMINATOR, code: 'denialreason' }] },
        reason: reason
          ? { coding: [{ system: CARC, code: reason.carc.code, display: reason.carc.display }], text: reason.text }
          : { coding: [{ system: CARC, code: '50' }], text: 'Denied' }
      }];

  return {
    resourceType: 'ExplanationOfBenefit',
    id: `pa-${record.drugKey}-${track}-${String(authId).toLowerCase()}`,
    ...(track === 'medical' ? { meta: { profile: [PDEX_PROFILES.priorAuthorization] } } : {}),
    identifier: [{ system: 'urn:payer:demo:prior-auth', value: authId }],
    status: 'active',
    type: { coding: [{ system: CLAIM_TYPE, code: track === 'medical' ? 'professional' : 'pharmacy' }] },
    use: 'preauthorization',
    patient: { reference: `Patient/${record.patientId}` },
    created: t.at,
    insurer: { display: payerDisplay },
    provider: providerNpi && /^\d{10}$/.test(providerNpi)
      ? { identifier: { system: 'http://hl7.org/fhir/sid/us-npi', value: providerNpi } }
      : providerNpi
      ? { display: `Requesting provider ${providerNpi}` }
      : practitionerRef
      ? { reference: practitionerRef }
      : { display: providerDisplay || 'Prescriber not identified' },
    outcome: 'complete',
    preAuthRef: [String(authId)],
    insurance: [{ focal: true, coverage: { reference: coverageRef } }],
    item: [
      {
        sequence: 1,
        productOrService,
        quantity: { value: form.quantity.value, unit: form.quantity.unit },
        adjudication
      }
    ]
  };
}
