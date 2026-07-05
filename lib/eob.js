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
