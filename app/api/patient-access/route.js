import { NextResponse } from 'next/server';
import { getLog } from '@/lib/db';
import { getPatient, PAYER_NAME, BENEFIT_YEAR } from '@/lib/patients';

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

  return NextResponse.json({
    smartScopes: REQUIRED_SCOPES,
    smartNote: 'Demo: SMART patient-launch auth is simulated. Production would require the patient to authenticate with the payer identity portal.',
    patient: {
      resourceType: 'Patient',
      id: patientId,
      name: [{ text: meta.name }],
      gender: meta.gender,
      birthDate: meta.dob,
    },
    coverage: {
      resourceType: 'Coverage',
      id: meta.coverageId,
      status: 'active',
      subscriberId: meta.subscriberId,
      planType: meta.planType,
      planName: meta.planName,
      payer: PAYER_NAME,
      benefitYear: BENEFIT_YEAR,
    },
    events,
  });
}
