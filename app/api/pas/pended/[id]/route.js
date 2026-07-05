import { NextResponse } from 'next/server';
import { finalizePendedIfDue } from '@/lib/pendedReview';

/**
 * Polling endpoint for pended PA requests. Finalization is request-driven:
 * once the clinical-review window has elapsed, the first poll to arrive
 * runs the finalization (lib/pendedReview.js) and receives the PAS
 * response Bundle that a rest-hook notification would deliver in
 * production. This keeps the flow correct on scale-to-zero hosts where no
 * background timer can be trusted to fire.
 */
export async function GET(request, { params }) {
  const req = finalizePendedIfDue(params.id);
  if (!req) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({
    status: req.status,
    authNumber: req.authNumber,
    vendor: req.vendor,
    responseBundle: req.responseBundle || null
  });
}
