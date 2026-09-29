import { NextResponse } from 'next/server';
import { outboundRateLimit } from '@/lib/rateLimit';
import { downloadExportFile, optumMode } from '@/lib/optumBackend';
import { logTransaction } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Optum Real Provider Access API -- Da Vinci bulk export NDJSON download.
 *
 * GET /api/optum/export/download/{fileName}
 *
 * Step 3. Fetches one of the NDJSON files listed in the manifest's
 * output[], returning parsed resources plus the raw NDJSON so the UI
 * can show both the shape and the line-by-line breakdown.
 */
export async function GET(_request, { params }) {
  const limited = outboundRateLimit('Optum', optumMode());
  if (limited) return limited;
  const { fileName } = params;
  try {
    const result = await downloadExportFile(fileName);
    logTransaction(
      'OPTUM',
      'BULK EXPORT DOWNLOAD',
      { mode: result.mode, fileName, resourceCount: result.resources?.length || 0 },
      {}
    );
    return NextResponse.json(result);
  } catch (e) {
    const status = e.status || 502;
    return NextResponse.json({ error: e.message, body: e.body, mode: optumMode() }, { status });
  }
}
