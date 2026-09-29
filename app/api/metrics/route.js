import { NextResponse } from 'next/server';
import { paMetrics, usageMetrics } from '@/lib/paMetrics';

export const dynamic = 'force-dynamic';

/**
 * GET /api/metrics
 *
 * API usage metrics (volume plus third-party success and error rates) and
 * prior authorization metrics (numeric counts plus percentages, medical and
 * drug), per CMS-0062-P position 4. Open, like a public posting would be.
 */
export async function GET() {
  return NextResponse.json({ usage: usageMetrics(), priorAuthorization: paMetrics() });
}
