import { NextResponse } from 'next/server';
import { bulkMemberMatch, optumMode } from '@/lib/optumBackend';
import { logTransaction } from '@/lib/db';
import { getPatient, PATIENT_LIST } from '@/lib/patients';

export const dynamic = 'force-dynamic';

/**
 * Optum Real Provider Access API -- Da Vinci PDex $bulk-member-match.
 *
 * POST /api/optum/provider-member-match
 * Body: { patientId?: string } -- one of the four demo patients from
 * lib/patients.js. Defaults to the first demo patient if omitted.
 *
 * Real payer-side provider access, alongside this sandbox's own
 * Provider Access API and Epic's EHR-side Backend Services read --
 * three different actor types (our payer, a real EHR, a real payer)
 * covering the same CMS-0057-F attribution concept.
 */
export async function POST(request) {
  let patientId;
  try {
    const body = await request.json();
    patientId = body?.patientId;
  } catch {
    // no JSON body supplied -- fall through to the default patient
  }
  const patient = getPatient(patientId) || PATIENT_LIST[0];

  try {
    const result = await bulkMemberMatch(patient);
    logTransaction(
      'OPTUM',
      'PROVIDER BULK MEMBER MATCH',
      { mode: result.mode, patient: patient.name },
      { patientId: patient.id }
    );
    return NextResponse.json({ ...result, patient: { id: patient.id, name: patient.name, subscriberId: patient.subscriberId } });
  } catch (e) {
    const status = e.status || 502;
    return NextResponse.json({ error: e.message, body: e.body, mode: optumMode() }, { status });
  }
}
