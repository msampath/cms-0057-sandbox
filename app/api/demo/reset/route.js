import { NextResponse } from 'next/server';
import { resetDemoState } from '@/lib/db';

/**
 * POST /api/demo/reset?mode=seeded|empty
 *
 * Restores the demo to a known state between walkthroughs.
 *
 *   mode=seeded (default) → snapshot rules + replayed demo traffic, the
 *                           same state a fresh boot produces
 *   mode=empty            → no rules, no traffic, so the upload → staging →
 *                           commit pipeline can be shown from a cold start
 */
export async function POST(request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('mode') === 'empty' ? 'empty' : 'seeded';
  const result = resetDemoState(mode);
  return NextResponse.json({ success: true, ...result });
}
