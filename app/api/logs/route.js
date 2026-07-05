import { NextResponse } from 'next/server';
import { getLog } from '@/lib/db';

// Parameter-less GET handlers are statically optimized by `next build`,
// which would freeze this response at build time. The log is runtime state.
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ logs: getLog() });
}
