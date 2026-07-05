import { NextResponse } from 'next/server';

/**
 * FHIR CapabilityStatement (GET [base]/metadata).
 *
 * Declares the resources and operations this simulator exposes and the
 * implementation guides it draws from. Content is static by design; FHIR
 * test tooling (Inferno, validator CLIs) probes this endpoint first.
 */

const CAPABILITY_STATEMENT = {
  resourceType: 'CapabilityStatement',
  id: 'cms-0057-demo',
  status: 'active',
  date: '2026-07-05',
  publisher: 'CMS-0057-F Interoperability Simulator (demo)',
  kind: 'instance',
  software: { name: 'cms-0057-demo', version: '2.0.0' },
  implementation: {
    description:
      'Demonstration implementation of the four payer APIs mandated by CMS-0057-F: Prior Authorization (CRD → DTR → PAS), Patient Access, Provider Access, and Payer-to-Payer.'
  },
  fhirVersion: '4.0.1',
  format: ['json'],
  implementationGuide: [
    'http://hl7.org/fhir/us/davinci-pas/ImplementationGuide/hl7.fhir.us.davinci-pas',
    'http://hl7.org/fhir/us/davinci-crd/ImplementationGuide/hl7.fhir.us.davinci-crd',
    'http://hl7.org/fhir/us/davinci-dtr/ImplementationGuide/hl7.fhir.us.davinci-dtr',
    'http://hl7.org/fhir/us/davinci-pdex/ImplementationGuide/hl7.fhir.us.davinci-pdex',
    'http://hl7.org/fhir/us/carin-bb/ImplementationGuide/hl7.fhir.us.carin-bb',
    'http://hl7.org/fhir/us/core/ImplementationGuide/hl7.fhir.us.core'
  ],
  rest: [
    {
      mode: 'server',
      documentation:
        'Demo server. SMART on FHIR scopes are declared per endpoint; see /api/patient-access, /api/provider-access, and /api/payer-to-payer.',
      resource: [
        {
          type: 'Claim',
          profile:
            'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-claim',
          operation: [
            {
              name: 'submit',
              definition:
                'http://hl7.org/fhir/us/davinci-pas/OperationDefinition/Claim-submit',
              documentation:
                'Implemented at POST /api/pas/submit accepting a PAS request Bundle (type collection).'
            }
          ]
        },
        {
          type: 'ClaimResponse',
          profile:
            'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-claimresponse',
          documentation:
            'Returned inside the PAS response Bundle and in Payer-to-Payer history Bundles (use: preauthorization).'
        },
        {
          type: 'Patient',
          profile:
            'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient',
          operation: [
            {
              name: 'member-match',
              definition:
                'http://hl7.org/fhir/us/davinci-hrex/OperationDefinition/member-match',
              documentation:
                'Implemented at POST /api/payer-to-payer/member-match accepting a Parameters resource with MemberPatient and CoverageToMatch.'
            }
          ]
        },
        {
          type: 'Coverage',
          profile:
            'http://hl7.org/fhir/us/carin-bb/StructureDefinition/C4BB-Coverage'
        },
        {
          type: 'ExplanationOfBenefit',
          profile:
            'http://hl7.org/fhir/us/carin-bb/StructureDefinition/C4BB-ExplanationOfBenefit-Professional-NonClinician',
          documentation:
            'CARIN BB shaped EOBs returned by the Patient Access API and in Payer-to-Payer history Bundles.'
        }
      ]
    }
  ]
};

export async function GET() {
  return NextResponse.json(CAPABILITY_STATEMENT);
}
