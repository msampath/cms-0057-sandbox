import { NextResponse } from 'next/server';
import { checkCoverage, availityMode } from '@/lib/availity';
import { logTransaction } from '@/lib/db';
import { getPatient } from '@/lib/patients';

export const dynamic = 'force-dynamic';

/**
 * Availity Coverages outbound endpoint (X12 270/271 eligibility check).
 *
 * POST /api/availity/coverage-check
 * Body: { patientId } -- one of the four demo patients from lib/patients.js
 *
 * This is the pre-order eligibility check side of the sandbox: when a
 * provider signs an order in /ehr, we fire this in parallel with the
 * CRD hook to verify the patient has active coverage/benefits at the
 * payer, via a real clearinghouse (Availity) rather than a payer
 * direct FHIR call. See lib/availity.js for the empirical notes on
 * scope/endpoint discovery.
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
  }

  const patient = getPatient(body?.patientId);
  if (!patient) {
    return NextResponse.json(
      { error: `Unknown patientId: ${body?.patientId}` },
      { status: 400 }
    );
  }

  const scenarioId = request.nextUrl.searchParams.get('scenarioId') || undefined;

  try {
    const result = await checkCoverage(patient, { scenarioId });
    const firstCoverage = result.response?.coverages?.[0];
    logTransaction(
      'AVAILITY',
      'COVERAGE CHECK',
      {
        mode: result.mode,
        coverageId: firstCoverage?.id,
        status: firstCoverage?.status,
        statusCode: firstCoverage?.statusCode,
        planStatus: firstCoverage?.plans?.[0]?.status
      },
      {
        npi: result.request?.providerNpi,
        memberId: result.request?.memberId,
        patientId: patient.id
      }
    );
    return NextResponse.json(result);
  } catch (e) {
    const status = e.status || 502;
    return NextResponse.json(
      { error: e.message, body: e.body, mode: availityMode() },
      { status }
    );
  }
}
