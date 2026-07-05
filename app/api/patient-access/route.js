import { NextResponse } from 'next/server';
import { getLog } from '@/lib/db';
import { getPatient, PAYER_NAME, BENEFIT_YEAR } from '@/lib/patients';
import { buildEob, CARIN_PROFILES, US_CORE_PROFILES } from '@/lib/eob';

// SMART on FHIR v2 patient-launch scopes that a production endpoint would require.
const REQUIRED_SCOPES = [
  'patient/Patient.read',
  'patient/Coverage.read',
  'patient/ExplanationOfBenefit.read',
  'patient/ClaimResponse.read',
];

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const patientId = searchParams.get('patientId');

  if (!patientId) {
    return NextResponse.json({ error: 'patientId query parameter is required' }, { status: 400 });
  }

  const meta = getPatient(patientId);
  if (!meta) {
    return NextResponse.json({ error: `Patient ${patientId} not found` }, { status: 404 });
  }

  // In production: validate SMART patient-launch token and confirm the token
  // subject matches the requested patientId. Demo: accepted as-is.

  const log = getLog();

  // All log entries attributed to this patient via the patientId meta field.
  const events = log
    .filter((e) => e.patientId === patientId)
    .map((e) => ({
      timestamp: e.timestamp,
      actor: e.actor,
      action: e.action,
      details: typeof e.details === 'string' ? e.details : JSON.stringify(e.details),
    }));

  // Resources are shaped to US Core (Patient) and CARIN BB (Coverage, EOB).
  // The envelope around them ({ smartScopes, patient, coverage, eobs,
  // events }) is a demo convenience: the events feed comes from the
  // transaction log and has no natural FHIR resource in this simulator.
  const eobs = (meta.currentPlanEobSummary || []).map((row, i) =>
    buildEob({
      id: `eob-${meta.subscriberId.toLowerCase()}-${i}`,
      patientId,
      patientName: meta.name,
      coverageRef: `Coverage/${meta.coverageId}`,
      payerDisplay: PAYER_NAME,
      row
    })
  );

  return NextResponse.json({
    smartScopes: REQUIRED_SCOPES,
    smartNote: 'Demo: SMART patient-launch auth is simulated. Production would require the patient to authenticate with the payer identity portal.',
    patient: {
      resourceType: 'Patient',
      id: patientId,
      meta: { profile: [US_CORE_PROFILES.patient] },
      identifier: [
        {
          type: {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
                code: 'MB',
                display: 'Member Number'
              }
            ]
          },
          system: 'urn:payer:bcbsil:member',
          value: meta.subscriberId
        }
      ],
      name: [{ text: meta.name, family: meta.family, given: meta.given }],
      gender: meta.gender,
      birthDate: meta.dob,
    },
    coverage: {
      resourceType: 'Coverage',
      id: meta.coverageId,
      meta: { profile: [CARIN_PROFILES.coverage] },
      status: 'active',
      subscriberId: meta.subscriberId,
      beneficiary: { reference: `Patient/${patientId}` },
      payor: [{ display: PAYER_NAME }],
      class: [
        {
          type: {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/coverage-class',
                code: 'plan'
              }
            ]
          },
          value: meta.planType,
          name: meta.planName
        }
      ],
      period: { start: `${BENEFIT_YEAR}-01-01`, end: `${BENEFIT_YEAR}-12-31` },
    },
    eobs,
    events,
  });
}
