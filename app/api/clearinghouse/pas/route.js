import { NextResponse } from 'next/server';
import { logTransaction } from '@/lib/db';
import { checkPasRequestBundle } from '@/lib/clearinghouse';
import { handlePOST as payerPasSubmit } from '@/app/api/pas/submit/route';
import { withUsage } from '@/lib/withUsage';

/**
 * POST /api/clearinghouse/pas
 *
 * A simulated clearinghouse hop in front of the payer's PAS endpoint. It
 * checks the PAS request Bundle's conformance and version before forwarding
 * (lib/clearinghouse.js). A failing Bundle is rejected here with a 422
 * OperationOutcome and never reaches the payer, so the standard holds at
 * the hand-off point (CMS-0062-P position 5).
 */
async function handlePOST(request) {
  const bundle = await request.json();
  const check = checkPasRequestBundle(bundle);
  const patientId = (Array.isArray(bundle?.entry) ? bundle.entry : []).find((e) => e?.resource?.resourceType === 'Patient')?.resource?.id || 'unknown';

  if (!check.ok) {
    logTransaction(
      'Clearinghouse',
      'CLEARINGHOUSE REJECTED',
      `PAS request rejected before reaching the payer: ${check.issues.filter((i) => i.severity === 'error').map((i) => i.diagnostics).join(' ')}`,
      { patientId }
    );
    return NextResponse.json(
      {
        resourceType: 'OperationOutcome',
        issue: check.issues.map((i) => ({ severity: i.severity, code: 'invalid', diagnostics: i.diagnostics }))
      },
      { status: 422 }
    );
  }

  logTransaction(
    'Clearinghouse',
    'CLEARINGHOUSE FORWARDED',
    `PAS request passed conformance (PAS ${check.version || 'unversioned'})${check.issues.length ? `, with warnings: ${check.issues.map((i) => i.diagnostics).join(' ')}` : ''}. Forwarded to the payer.`,
    { patientId }
  );

  // Forward the same Bundle to the payer's PAS handler in process. The
  // unmetered handler is used so the call is counted once, under
  // Clearinghouse, and a fresh Request carries only the headers PAS needs
  // (the incoming content-length would not match the re-serialized body).
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const h of ['x-forwarded-host', 'x-forwarded-proto', 'host']) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  const forwarded = new Request(new URL('/cms-0057/api/pas/submit', request.url), {
    method: 'POST',
    headers,
    body: JSON.stringify(bundle)
  });
  return payerPasSubmit(forwarded);
}

// Usage metrics (CMS-0062-P): one event per call, bucketed by outcome.
export const POST = withUsage('Clearinghouse', handlePOST);
