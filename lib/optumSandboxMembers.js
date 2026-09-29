/**
 * Optum sandbox members -- the two demographic profiles Optum's own
 * Try-It documentation submits (and expects back as matches) against
 * the Real Provider Access API's Group/$bulk-member-match operation.
 *
 * Provenance: captured 2026-08-18 from Optum's developer portal
 * (developer.optum.com/optumreal-medical/reference/bulkmembermatch-1),
 * extracted from the ReadMe-hosted OpenAPI spec embedded in the page.
 * The OAS request example carries one MembersToMatch part; the 200
 * response echoes two matched contained Patients. Both demographic
 * profiles are recorded here so the /um Provider Access panel can
 * offer more than one recognized member.
 *
 * Why this exists at all: Optum's sandbox has no real member roster.
 * The gateway (environment: sandbox header) returns canned data
 * regardless of what the client submits. But the canned response
 * marks exactly these demographics as MatchedMembers, so submitting
 * one of them is the closest thing to a "real Optum member match"
 * this sandbox tier makes possible.
 *
 * Contrast with lib/patients.js: those six BCBSIL demo patients are
 * this sandbox's OWN test population, unrelated to Optum's roster --
 * they legitimately land in NonMatchedMembers, and the UI panel
 * documents that honestly.
 *
 * Pure data module, no fs / Node imports, so both server routes
 * and client components can import it (same pattern as lib/patients.js).
 */

export const OPTUM_SANDBOX_MEMBERS = {
  'optum-emr-98765': {
    id: 'optum-emr-98765',
    label: 'givenName givenName2 Person (EMR-98765) — Optum canonical match',
    // Verbatim from the OAS request example.
    memberPatient: {
      resourceType: 'Patient',
      id: 'patient-provider-1',
      text: {
        status: 'generated',
        div: '<div xmlns="http://www.w3.org/1999/xhtml">Patient firstName lastName</div>'
      },
      identifier: [
        {
          type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MB' }] },
          system: 'http://example.org/provider-emr/identifiers/patient',
          value: 'EMR-98765',
          assigner: { display: 'Provider 1 EMR System' }
        }
      ],
      name: [{ use: 'official', family: 'Person', given: ['givenName', 'givenName2'] }],
      gender: 'female',
      birthDate: '1974-12-25'
    },
    coverageToMatch: {
      resourceType: 'Coverage',
      id: 'coverage-provider-1',
      text: {
        status: 'generated',
        div: '<div xmlns="http://www.w3.org/1999/xhtml">Coverage information from insurance card</div>'
      },
      identifier: [
        {
          type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MB' }] },
          system: 'http://example.org/health-plan',
          value: 'HP-12345678'
        }
      ],
      status: 'active',
      subscriberId: 'SUB-987654321',
      beneficiary: { reference: 'Patient/patient-provider-1' },
      relationship: {
        coding: [{ system: 'http://terminology.hl7.org/CodeSystem/subscriber-relationship', code: 'self' }]
      },
      period: { start: '2024-01-01', end: '2024-12-31' },
      payor: [
        {
          identifier: { system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' },
          display: 'Example Health Plan'
        }
      ],
      class: [
        {
          type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/coverage-class', code: 'group' }] },
          value: 'GRP-001'
        },
        {
          type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/coverage-class', code: 'plan' }] },
          value: 'PLAN-GOLD'
        }
      ]
    },
    // Verbatim from the OAS request example -- provider treatment-relationship
    // attestation Consent. Required by the multi-member-match-bundle-in profile.
    consent: {
      resourceType: 'Consent',
      id: 'consent-provider-1',
      text: {
        status: 'generated',
        div: '<div xmlns="http://www.w3.org/1999/xhtml">Provider attestation to treatment relationship</div>'
      },
      status: 'active',
      scope: {
        coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: 'treatment' }]
      },
      category: [
        {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
              code: 'IDSCL',
              display: 'Information Disclosure'
            }
          ]
        },
        {
          coding: [{ system: 'http://loinc.org', code: '64292-6', display: 'Release of information consent' }]
        }
      ],
      patient: { reference: 'Patient/patient-provider-1' },
      dateTime: '2024-11-14T10:30:00Z',
      performer: [{ reference: 'Practitioner/4', display: 'Dr. Susan Smith' }],
      sourceReference: { reference: 'DocumentReference/provider-attestation-doc-1' },
      policy: [{ uri: 'https://example.org/provider-attestation-policy' }],
      verification: [
        {
          verified: true,
          verifiedWith: { reference: 'Patient/patient-provider-1' },
          verificationDate: '2024-11-14T10:30:00Z'
        }
      ],
      provision: {
        type: 'permit',
        period: { start: '2024-01-15' },
        actor: [
          {
            role: {
              coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'IRCP' }]
            },
            reference: {
              identifier: { system: 'http://hl7.org/fhir/sid/us-npi', value: '1982943213' },
              display: 'Dr. Susan Smith'
            }
          },
          {
            role: {
              coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-RoleClass', code: 'PROV' }]
            },
            reference: {
              identifier: { system: 'http://hl7.org/fhir/sid/us-npi', value: '1982947230' },
              display: 'Provider 1'
            }
          }
        ],
        purpose: [
          { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'TREAT' },
          { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HPAYMT' },
          { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HOPERAT' }
        ]
      }
    }
  },

  // Second member -- demographics taken from the 200 response's
  // MatchedMembers.contained[1] (provider-submitted-patient-2). Optum's
  // canned response marks this profile as matched too, so the toggle
  // has more than one recognized identity to offer. Coverage/Consent
  // are cloned from Member 1 with ids rebased.
  'optum-emr-45678': {
    id: 'optum-emr-45678',
    label: 'John Michael Doe (EMR-45678) — Optum canonical match',
    memberPatient: {
      resourceType: 'Patient',
      id: 'patient-provider-2',
      identifier: [
        {
          type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MB' }] },
          system: 'http://example.org/provider-emr/identifiers/patient',
          value: 'EMR-45678',
          assigner: { display: 'Provider 1 EMR System' }
        }
      ],
      name: [{ use: 'official', family: 'Doe', given: ['John', 'Michael'] }],
      gender: 'male',
      birthDate: '1985-06-15'
    },
    coverageToMatch: {
      resourceType: 'Coverage',
      id: 'coverage-provider-2',
      identifier: [
        {
          type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MB' }] },
          system: 'http://example.org/health-plan',
          value: 'HP-23456789'
        }
      ],
      status: 'active',
      subscriberId: 'SUB-234567890',
      beneficiary: { reference: 'Patient/patient-provider-2' },
      relationship: {
        coding: [{ system: 'http://terminology.hl7.org/CodeSystem/subscriber-relationship', code: 'self' }]
      },
      period: { start: '2024-01-01', end: '2024-12-31' },
      payor: [
        {
          identifier: { system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' },
          display: 'Example Health Plan'
        }
      ],
      class: [
        {
          type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/coverage-class', code: 'group' }] },
          value: 'GRP-002'
        }
      ]
    },
    consent: {
      resourceType: 'Consent',
      id: 'consent-provider-2',
      status: 'active',
      scope: {
        coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: 'treatment' }]
      },
      category: [
        {
          coding: [{ system: 'http://loinc.org', code: '64292-6', display: 'Release of information consent' }]
        }
      ],
      patient: { reference: 'Patient/patient-provider-2' },
      dateTime: '2024-11-14T10:30:00Z',
      performer: [{ reference: 'Practitioner/4', display: 'Dr. Susan Smith' }],
      policy: [{ uri: 'https://example.org/provider-attestation-policy' }],
      provision: {
        type: 'permit',
        period: { start: '2024-01-15' },
        purpose: [
          { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'TREAT' },
          { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HPAYMT' }
        ]
      }
    }
  }
};

export const OPTUM_SANDBOX_MEMBER_LIST = Object.values(OPTUM_SANDBOX_MEMBERS);

export function getOptumSandboxMember(id) {
  return typeof id === 'string' && Object.hasOwn(OPTUM_SANDBOX_MEMBERS, id) ? OPTUM_SANDBOX_MEMBERS[id] : null;
}
