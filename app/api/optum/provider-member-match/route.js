import { NextResponse } from 'next/server';
import { bulkMemberMatch, optumMode } from '@/lib/optumBackend';
import { logTransaction } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Optum Real Provider Access API -- Da Vinci PDex $bulk-member-match.
 *
 * POST /api/optum/provider-member-match
 *
 * Real payer-side provider access, alongside this sandbox's own
 * Provider Access API and Epic's EHR-side Backend Services read --
 * three different actor types (our payer, a real EHR, a real payer)
 * covering the same CMS-0057-F attribution concept.
 */
export async function POST() {
  try {
    const result = await bulkMemberMatch();
    logTransaction('OPTUM', 'PROVIDER BULK MEMBER MATCH', { mode: result.mode }, {});
    return NextResponse.json(result);
  } catch (e) {
    const status = e.status || 502;
    return NextResponse.json({ error: e.message, body: e.body, mode: optumMode() }, { status });
  }
}
