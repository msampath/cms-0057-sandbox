import { NextResponse } from 'next/server';
import { outboundRateLimit } from '@/lib/rateLimit';
import { kickoffDavinciExport, optumMode } from '@/lib/optumBackend';
import { logTransaction } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Optum Real Provider Access API -- Da Vinci $davinci-data-export kickoff.
 *
 * POST /api/optum/export/kickoff
 * Body: { groupId?: string }  // defaults to provider-matched-group-001
 *                              // (the id our A2 mock response returns)
 *
 * Step 1 of the three-step async bulk export flow. 200/202 with an
 * OperationOutcome body; polling URL comes back in Content-Location.
 */
export async function POST(request) {
  const limited = outboundRateLimit('Optum', optumMode());
  if (limited) return limited;
  let body = {};
  try {
    body = await request.json();
  } catch {
    // fall through
  }
  const groupId = body?.groupId || 'provider-matched-group-001';

  try {
    const result = await kickoffDavinciExport(groupId);
    logTransaction(
      'OPTUM',
      'BULK EXPORT KICKOFF',
      { mode: result.mode, groupId, contentLocation: result.contentLocation, jobId: result.jobId },
      {}
    );
    return NextResponse.json(result);
  } catch (e) {
    const status = e.status || 502;
    return NextResponse.json({ error: e.message, body: e.body, mode: optumMode() }, { status });
  }
}
