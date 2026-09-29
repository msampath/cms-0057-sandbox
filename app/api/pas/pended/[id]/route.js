import { NextResponse } from 'next/server';
import { finalizePendedIfDue } from '@/lib/pendedReview';
import { withUsage } from '@/lib/withUsage';

/**
 * Polling endpoint for pended PA requests. Finalization is request-driven:
 * once the clinical-review window has elapsed, the first poll to arrive
 * runs the finalization (lib/pendedReview.js) and receives the PAS
 * response Bundle that a rest-hook notification would deliver in
 * production. This keeps the flow correct on scale-to-zero hosts where no
 * background timer can be trusted to fire.
 */
async function handleGET(request, { params }) {
  const req = finalizePendedIfDue(params.id);
  if (!req) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({
    status: req.status,
    authNumber: req.authNumber,
    vendor: req.vendor,
    responseBundle: req.responseBundle || null
  });
}

// Usage metrics (CMS-0062-P): one event per call, bucketed by outcome.
export const GET = withUsage('Prior Authorization', handleGET);
