import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

/**
 * GET /api/schema
 *
 * Returns every non-runtime section of the CRD data model in one payload:
 * payer, plans, network_tiers, service_categories, questionnaires,
 * gold_card_programs. Useful for the UM Dashboard's Schema Explorer panel.
 * Rule rows are excluded (they're large — fetched separately via /api/rules).
 */

// Parameter-less GET handlers are statically optimized by `next build`,
// which would freeze this response at build time. Sections are runtime state.
export const dynamic = 'force-dynamic';

export async function GET() {
  const db = getDb();
  return NextResponse.json({
    payer: db.payer,
    plans: db.plans,
    network_tiers: db.network_tiers,
    service_categories: db.service_categories,
    questionnaires: db.questionnaires,
    gold_card_programs: db.gold_card_programs
  });
}
