import { NextResponse } from 'next/server';
import { probePdfExtraction } from '@/lib/python';

/**
 * GET /api/extract/health
 *
 * Reports whether live PDF extraction can work on this host (Python with
 * pdfplumber importable). The UM upload form checks this once so the
 * limitation is visible before a failed upload rather than after. The
 * probe result is cached for the process lifetime.
 */

// Parameter-less GET handlers are statically optimized by `next build`;
// this one must probe the runtime host.
export const dynamic = 'force-dynamic';

export async function GET() {
  const result = await probePdfExtraction();
  return NextResponse.json(result);
}
