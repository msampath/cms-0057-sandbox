import { NextResponse } from 'next/server';
import { getLog } from '@/lib/db';

// Static patient demographics keyed by the demo patient IDs.
// These mirror the PATIENT_SCENARIOS in app/ehr/page.jsx.
const PATIENT_META = {
  'pat-8849-jane-doe':    { name: 'Jane Doe',        dob: '1972-04-14', planType: 'COMM-PPO' },
  'pat-7712-robert-chen': { name: 'Robert Chen',     dob: '1955-09-22', planType: 'MA-PPO'   },
  'pat-3301-dorothy-hayes':{ name: 'Dorothy Hayes',  dob: '1948-03-07', planType: 'COMM-PPO' },
  'pat-6614-marcus-johnson':{ name: 'Marcus Johnson', dob: '2014-11-19', planType: 'COMM-HMO' },
};

// SMART on FHIR v2 scopes that a production endpoint would require.
const REQUIRED_SCOPES = [
  'system/Patient.read',
  'system/ExplanationOfBenefit.read',
  'system/ClaimResponse.read',
];

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const npi = searchParams.get('npi');

  // In production: validate SMART backend-services token here.
  // Demo: NPI is accepted as-is from the query parameter.

  const log = getLog();

  // Collect all log entries that carry the npi meta field and have a real patientId.
  const relevant = log.filter((entry) => {
    if (!entry.patientId || entry.patientId === 'unknown') return false;
    if (npi && entry.npi !== npi) return false;
    return true;
  });

  // Group events by patient, latest first.
  const byPatient = new Map();
  for (const entry of relevant) {
    const pid = entry.patientId;
    if (!byPatient.has(pid)) {
      const meta = PATIENT_META[pid] || {};
      byPatient.set(pid, {
        patientId: pid,
        patientName: meta.name || pid,
        dob: meta.dob || null,
        planType: meta.planType || '—',
        attributedNpi: entry.npi || null,
        events: [],
      });
    }
    byPatient.get(pid).events.push({
      timestamp: entry.timestamp,
      actor: entry.actor,
      action: entry.action,
      details: typeof entry.details === 'string' ? entry.details : JSON.stringify(entry.details),
    });
  }

  const patients = Array.from(byPatient.values()).map((p) => ({
    ...p,
    lastActivity: p.events[0]?.timestamp || null,
    eventCount: p.events.length,
  }));

  return NextResponse.json({
    npi: npi || null,
    smartScopes: REQUIRED_SCOPES,
    smartNote: 'Demo: SMART backend-services auth is simulated. Production would require a signed JWT and token introspection.',
    patients,
  });
}
