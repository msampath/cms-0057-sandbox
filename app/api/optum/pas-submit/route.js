import { NextResponse } from 'next/server';
import { submitClaim, optumMode } from '@/lib/optumBackend';
import { logTransaction } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Optum Real Prior Authorization API -- Claim/$submit.
 *
 * POST /api/optum/pas-submit
 * Body: the same PAS FHIR Bundle /api/pas/submit and
 * /api/availity/service-review receive -- Optum's Claim/$submit expects a
 * Da Vinci PAS-shaped Bundle too, so it is forwarded with no
 * transformation. This is the third parallel PAS path alongside this
 * sandbox's own engine and Availity's X12 278 projection: same Bundle,
 * submitted to a real independent payer's implementation of the same
 * CMS-0057-F mandate.
 */
export async function POST(request) {
  let bundle;
  try {
    bundle = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be a JSON FHIR Bundle' }, { status: 400 });
  }

  try {
    const result = await submitClaim(bundle);
    logTransaction(
      'OPTUM',
      'PAS CLAIM SUBMIT',
      { mode: result.mode, outcome: result.response?.entry?.[0]?.resource?.outcome },
      { patientId: bundle?.entry?.find((e) => e?.resource?.resourceType === 'Patient')?.resource?.id }
    );
    return NextResponse.json(result);
  } catch (e) {
    const status = e.status || 502;
    return NextResponse.json({ error: e.message, body: e.body, mode: optumMode() }, { status });
  }
}
