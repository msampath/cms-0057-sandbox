import { NextResponse } from 'next/server';
import { getLog } from '@/lib/db';
import { getPatient } from '@/lib/patients';
import { requireScopes, AUTH_ENABLED } from '@/lib/auth';

// SMART on FHIR v2 scopes that a production endpoint would require.
const REQUIRED_SCOPES = [
  'system/Patient.read',
  'system/ExplanationOfBenefit.read',
  'system/ClaimResponse.read',
];

export async function GET(request) {
  // Demo JWT enforcement (backend-services flavor): 401 without a Bearer
  // token, 403 on missing scopes. Production would require a signed client
  // assertion and token introspection rather than a shared demo secret.
  const denied = requireScopes(request, REQUIRED_SCOPES);
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const npi = searchParams.get('npi');

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
      const meta = getPatient(pid) || {};
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
    smartNote: AUTH_ENABLED
      ? 'Demo JWT enforced: this response was authorized by a client_credentials Bearer token. Production backend services would use a signed client assertion per SMART v2.'
      : 'Demo auth is disabled (DEMO_AUTH=off).',
    patients,
  });
}
