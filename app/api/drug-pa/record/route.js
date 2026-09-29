import { NextResponse } from 'next/server';
import { getDrugPaRecord } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/drug-pa/record?patientId=&drugKey=
 *
 * The shared drug PA record: answers, determination, reason, and an entry
 * per benefit track that has touched it. The EHR reads it to prefill one
 * track from the other.
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const patientId = searchParams.get('patientId');
  const drugKey = searchParams.get('drugKey');
  if (!patientId || !drugKey) {
    return NextResponse.json({ error: 'patientId and drugKey are required' }, { status: 400 });
  }
  return NextResponse.json({ record: getDrugPaRecord(patientId, drugKey) });
}
