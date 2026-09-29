import { NextResponse } from 'next/server';
import { bodyTooLarge } from '@/lib/bodyLimit';
import { outboundRateLimit } from '@/lib/rateLimit';
import { bulkMemberMatch, optumMode } from '@/lib/optumBackend';
import { logTransaction } from '@/lib/db';
import { getPatient, PATIENT_LIST } from '@/lib/patients';
import { getOptumSandboxMember } from '@/lib/optumSandboxMembers';

export const dynamic = 'force-dynamic';

/**
 * Optum Real Provider Access API -- Da Vinci PDex $bulk-member-match.
 *
 * POST /api/optum/provider-member-match
 * Body: {
 *   source: 'sandbox' | 'demo',                  // default 'sandbox'
 *   sandboxMemberId?: string,                    // when source==='sandbox'
 *   patientId?: string,                          // when source==='demo'
 *   npi?: string                                 // the panel's active NPI;
 *                                                // logged so /api/provider-access
 *                                                // surfaces this event in its
 *                                                // NPI-scoped panel
 * }
 *
 * `sandbox` submits one of Optum's own canonical Try-It members
 * (lib/optumSandboxMembers.js) -- these come back MATCHED because
 * Optum's canned sandbox response marks their exact demographics.
 * `demo` submits one of this sandbox's BCBSIL demo patients
 * (lib/patients.js) -- these land in NonMatchedMembers because
 * Optum's roster does not know them. Both outcomes are truthful and
 * make different points; the /um panel toggles between them.
 */
export async function POST(request) {
  const oversized = bodyTooLarge(request, 64 * 1024);
  if (oversized) return oversized;
  const limited = outboundRateLimit('Optum', optumMode());
  if (limited) return limited;
  let body = {};
  try {
    body = await request.json();
  } catch {
    // fall through with defaults
  }
  const source = body?.source === 'demo' ? 'demo' : 'sandbox';

  let subject;
  let displayName;
  let displayId;
  let subjectNpi;
  if (source === 'sandbox') {
    subject = getOptumSandboxMember(body?.sandboxMemberId) || getOptumSandboxMember('optum-emr-98765');
    displayName = subject.memberPatient?.name?.[0]
      ? `${(subject.memberPatient.name[0].given || []).join(' ')} ${subject.memberPatient.name[0].family}`.trim()
      : subject.label;
    // The FHIR identifier Optum echoes back in its response's contained
    // Patient (e.g. "EMR-98765"), not our internal registry key.
    displayId = subject.memberPatient?.identifier?.[0]?.value || subject.id;
  } else {
    subject = getPatient(body?.patientId) || PATIENT_LIST[0];
    displayName = subject.name;
    displayId = subject.subscriberId;
    subjectNpi = subject.npi;
  }
  // The /um panel sends its active NPI so the entry shows in that panel.
  // A demo patient is attributed only to its own NPI, so a caller cannot
  // attach one member to another provider's panel. Sandbox members are not
  // demo patients, so the panel NPI is kept for them.
  const clientNpi = typeof body?.npi === 'string' && /^[A-Za-z0-9-]{1,20}$/.test(body.npi) ? body.npi : null;
  const logNpi = source === 'demo' ? subjectNpi : clientNpi;

  try {
    const result = await bulkMemberMatch(subject);
    logTransaction(
      'OPTUM',
      'PROVIDER BULK MEMBER MATCH',
      { mode: result.mode, source, subject: displayName },
      {
        npi: logNpi,
        patientId: source === 'demo' ? subject.id : undefined
      }
    );
    return NextResponse.json({
      ...result,
      source,
      subject: { id: subject.id, name: displayName, identifier: displayId }
    });
  } catch (e) {
    const status = e.status || 502;
    return NextResponse.json({ error: e.message, body: e.body, mode: optumMode() }, { status });
  }
}
