import { NextResponse } from 'next/server';
import { fetchQuestionnairePackage, optumMode } from '@/lib/optumBackend';
import { logTransaction } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Optum Real Prior Authorization API -- DTR Questionnaire retrieval.
 *
 * POST /api/optum/dtr-questionnaire
 * Body: { patientId }
 *
 * Retrieves a real Da Vinci DTR questionnaire package from Optum's
 * sandbox, shown as a reference panel alongside this sandbox's own DTR
 * pane (which continues to drive the actual PAS submission).
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
  }

  try {
    const result = await fetchQuestionnairePackage(body);
    logTransaction(
      'OPTUM',
      'DTR QUESTIONNAIRE-PACKAGE',
      { mode: result.mode },
      { patientId: body.patientId }
    );
    return NextResponse.json(result);
  } catch (e) {
    const status = e.status || 502;
    return NextResponse.json({ error: e.message, body: e.body, mode: optumMode() }, { status });
  }
}
