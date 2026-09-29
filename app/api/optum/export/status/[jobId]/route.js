import { NextResponse } from 'next/server';
import { outboundRateLimit } from '@/lib/rateLimit';
import { pollExportStatus, optumMode } from '@/lib/optumBackend';
import { logTransaction } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Optum Real Provider Access API -- Da Vinci bulk export status poll.
 *
 * GET /api/optum/export/status/{jobId}
 *
 * Step 2. Returns the manifest with output[] and error[] arrays of
 * NDJSON file URLs, or a 202 if the export is still running.
 */
export async function GET(_request, { params }) {
  const limited = outboundRateLimit('Optum', optumMode());
  if (limited) return limited;
  const { jobId } = params;
  try {
    const result = await pollExportStatus(jobId);
    logTransaction(
      'OPTUM',
      'BULK EXPORT STATUS',
      { mode: result.mode, jobId, status: result.status, files: result.response?.output?.length || 0 },
      {}
    );
    return NextResponse.json(result);
  } catch (e) {
    const status = e.status || 502;
    return NextResponse.json({ error: e.message, body: e.body, mode: optumMode() }, { status });
  }
}
