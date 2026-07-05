import { NextResponse } from 'next/server';
import { getLog } from '@/lib/db';

// Static patient metadata mirroring PATIENT_SCENARIOS in app/ehr/page.jsx.
const PATIENT_META = {
  'pat-8849-jane-doe': {
    name: 'Jane Doe',
    dob: '1972-04-14',
    gender: 'female',
    planType: 'COMM-PPO',
    planName: 'Commercial PPO',
    coverageId: 'cov-comm-ppo-bcbsil',
    subscriberId: 'BCBSIL-MEM-849',
    payer: 'Blue Cross Blue Shield of Illinois',
    benefitYear: '2026',
  },
  'pat-7712-robert-chen': {
    name: 'Robert Chen',
    dob: '1955-09-22',
    gender: 'male',
    planType: 'MA-PPO',
    planName: 'Medicare Advantage PPO',
    coverageId: 'cov-ma-ppo-bcbsil',
    subscriberId: 'BCBSIL-MEM-712',
    payer: 'Blue Cross Blue Shield of Illinois',
    benefitYear: '2026',
  },
  'pat-3301-dorothy-hayes': {
    name: 'Dorothy Hayes',
    dob: '1948-03-07',
    gender: 'female',
    planType: 'COMM-PPO',
    planName: 'Commercial PPO',
    coverageId: 'cov-comm-ppo-bcbsil',
    subscriberId: 'BCBSIL-MEM-301',
    payer: 'Blue Cross Blue Shield of Illinois',
    benefitYear: '2026',
  },
  'pat-6614-marcus-johnson': {
    name: 'Marcus Johnson',
    dob: '2014-11-19',
    gender: 'male',
    planType: 'COMM-HMO',
    planName: 'Commercial HMO',
    coverageId: 'cov-comm-hmo-bcbsil',
    subscriberId: 'BCBSIL-MEM-614',
    payer: 'Blue Cross Blue Shield of Illinois',
    benefitYear: '2026',
  },
};

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

  const meta = PATIENT_META[patientId];
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
      payer: meta.payer,
      benefitYear: meta.benefitYear,
    },
    events,
  });
}
