import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

/**
 * GET /api/rules
 *
 * Returns the committed rules index. The UM Dashboard's Rules Explorer
 * polls this so newly-committed grids appear without a page reload.
 */

// Parameter-less GET handlers are statically optimized by `next build`,
// which would freeze this response at build time. Rules are runtime state.
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ rules: getDb().rules });
}
