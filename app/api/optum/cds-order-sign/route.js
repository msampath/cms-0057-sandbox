import { NextResponse } from 'next/server';
import { bodyTooLarge } from '@/lib/bodyLimit';
import { outboundRateLimit } from '@/lib/rateLimit';
import { fetchOrderSignCard, optumMode } from '@/lib/optumBackend';
import { logTransaction } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Optum Real Prior Authorization API -- CDS Hooks order-sign.
 *
 * POST /api/optum/cds-order-sign
 * Body: { patientId, practitionerId, code, display }
 *
 * A second, independent CRD opinion on the same order this sandbox's
 * own engine evaluates -- this one from a real UnitedHealthcare-shaped
 * Da Vinci CRD implementation.
 */
export async function POST(request) {
  const oversized = bodyTooLarge(request, 64 * 1024);
  if (oversized) return oversized;
  const limited = outboundRateLimit('Optum', optumMode());
  if (limited) return limited;
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 });
  }

  try {
    const result = await fetchOrderSignCard(body);
    logTransaction(
      'OPTUM',
      'CRD ORDER-SIGN',
      { mode: result.mode, cardCount: result.cards?.cards?.length || 0 },
      { code: typeof body.code === 'string' ? body.code : undefined, patientId: typeof body.patientId === 'string' ? body.patientId : undefined }
    );
    return NextResponse.json(result);
  } catch (e) {
    const status = e.status || 502;
    return NextResponse.json({ error: e.message, body: e.body, mode: optumMode() }, { status });
  }
}
