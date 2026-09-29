import { NextResponse } from 'next/server';
import { IG_REGISTRY, versionedCanonical } from '@/lib/fhir';

/**
 * FHIR CapabilityStatement (GET [base]/metadata).
 *
 * Declares the resources and operations this simulator exposes and the
 * implementation guides it draws from. Content is static by design; FHIR
 * test tooling (Inferno, validator CLIs) probes this endpoint first.
 *
 * IG and profile canonicals carry a `|version` suffix wherever the sandbox
 * implements a specific version (IG_REGISTRY in lib/fhir.js). DTR is listed
 * without a version because the sandbox's questionnaires are not built to
 * one.
 */

const CAPABILITY_STATEMENT = {
  resourceType: 'CapabilityStatement',
  id: 'cms-0057-sandbox',
  status: 'active',
  date: '2026-09-28',
  publisher: 'CMS-0057-F Interoperability Sandbox (demo)',
  kind: 'instance',
  software: { name: 'cms-0057-sandbox', version: '2.0.0' },
  implementation: {
    description:
      'Demonstration implementation of the four payer APIs mandated by CMS-0057-F: Prior Authorization (CRD → DTR → PAS), Patient Access, Provider Access, and Payer-to-Payer.'
  },
  fhirVersion: '4.0.1',
  format: ['json'],
  implementationGuide: IG_REGISTRY.filter((ig) => ig.key !== 'cdex').map((ig) =>
    versionedCanonical(ig.canonical, ig.key)
  ),
  rest: [
    {
      mode: 'server',
      documentation:
        'Demo server. SMART on FHIR scopes are declared per endpoint; see /api/patient-access, /api/provider-access, and /api/payer-to-payer.',
      resource: [
        {
          type: 'Claim',
          profile: versionedCanonical(
            'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-claim',
            'pas'
          ),
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
          profile: versionedCanonical(
            'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-claimresponse',
            'pas'
          ),
          documentation:
            'Returned inside the PAS response Bundle and in Payer-to-Payer history Bundles (use: preauthorization).'
        },
        {
          type: 'Patient',
          profile: versionedCanonical(
            'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient',
            'us-core'
          ),
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
          profile: versionedCanonical(
            'http://hl7.org/fhir/us/carin-bb/StructureDefinition/C4BB-Coverage',
            'carin-bb'
          )
        },
        {
          type: 'ExplanationOfBenefit',
          profile: versionedCanonical(
            'http://hl7.org/fhir/us/carin-bb/StructureDefinition/C4BB-ExplanationOfBenefit-Professional-NonClinician',
            'carin-bb'
          ),
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
