import { NextResponse } from 'next/server';
import { getPendingRequest } from '@/lib/db';

/**
 * Polling endpoint for pended PA requests. Once the clinical review
 * finalizes, `responseBundle` carries the PAS response Bundle
 * (ClaimResponse + coverage-information Task) that the rest-hook
 * notification would deliver in production.
 */
export async function GET(request, { params }) {
  const req = getPendingRequest(params.id);
  if (!req) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({
    status: req.status,
    authNumber: req.authNumber,
    vendor: req.vendor,
    responseBundle: req.responseBundle || null
  });
}
