import { NextResponse } from 'next/server';
import { fetchOrderSignCard, optumMode } from '@/lib/optumBackend';
import { logTransaction } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Optum Real Prior Authorization API -- CDS Hooks order-sign.
 *
 * POST /api/optum/cds-order-sign
 * Body: { patientId, practitionerId, code, display }
 *
 * A third, independent CRD opinion on the same order this sandbox's own
 * engine and Availity's X12 278 path evaluate -- this one from a real
 * UnitedHealthcare-shaped Da Vinci CRD implementation.
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
  }

  try {
    const result = await fetchOrderSignCard(body);
    logTransaction(
      'OPTUM',
      'CRD ORDER-SIGN',
      { mode: result.mode, cardCount: result.cards?.cards?.length || 0 },
      { code: body.code, patientId: body.patientId }
    );
    return NextResponse.json(result);
  } catch (e) {
    const status = e.status || 502;
    return NextResponse.json({ error: e.message, body: e.body, mode: optumMode() }, { status });
  }
}
