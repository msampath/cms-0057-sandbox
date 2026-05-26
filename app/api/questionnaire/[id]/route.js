import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { logTransaction } from '@/lib/db';

/**
 * GET /api/questionnaire/[id]
 *
 * Serves the pre-authored FHIR R4 Questionnaire resource bound to a rule
 * during Phase 1 artifact binding. The DTR surface fetches this on SMART
 * launch and renders item[] dynamically.
 */
export async function GET(_request, { params }) {
  const { id } = params;

  // Defensive: only allow simple ids (no path traversal).
  if (!/^[a-z0-9_-]+$/i.test(id)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }

  const file = path.join(process.cwd(), 'data', 'questionnaires', `${id}.json`);
  if (!fs.existsSync(file)) {
    logTransaction('DTR Gateway', 'QUESTIONNAIRE NOT FOUND', `Questionnaire id=${id} missing on disk.`);
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  logTransaction('DTR Gateway', 'QUESTIONNAIRE SERVED', `Served Questionnaire/${id} (${json.item?.length ?? 0} items).`);
  return NextResponse.json(json);
}
