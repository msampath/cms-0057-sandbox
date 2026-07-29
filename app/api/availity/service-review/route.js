import { NextResponse } from 'next/server';
import { submitServiceReview, availityMode } from '@/lib/availity';
import { logTransaction } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Availity Service Reviews outbound endpoint.
 *
 * POST /api/availity/service-review
 *
 * Body: the same PAS FHIR Bundle the sandbox's own /api/pas/submit receives.
 * Response: { request, response, mode } where request is the Availity JSON
 * projection, response is Availity's Service Reviews response (or a mock
 * if credentials are not configured), and mode is 'live' | 'mock-no-credentials'
 * | 'mock-forced' | 'disabled'.
 *
 * This lets the sandbox demonstrate the FHIR PAS path and the X12 278
 * clearinghouse path running side by side, which mirrors how a real health
 * system routes prior authorizations today: FHIR to the payer directly per
 * CMS-0057-F, X12 278 to the payer via a clearinghouse for the legacy
 * channel.
 */
export async function POST(request) {
  let bundle;
  try {
    bundle = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Body must be a JSON FHIR Bundle' },
      { status: 400 }
    );
  }

  const scenarioId = request.nextUrl.searchParams.get('scenarioId') || undefined;

  try {
    const result = await submitServiceReview(bundle, { scenarioId });
    logTransaction(
      'AVAILITY',
      'SERVICE-REVIEW SUBMIT',
      {
        mode: result.mode,
        controlNumber: result.response?.controlNumber,
        certificationNumber: result.response?.certificationNumber,
        status: result.response?.status
      },
      {
        code: result.request?.services?.[0]?.code,
        npi: result.request?.provider?.npi,
        patientId: bundle?.entry?.find((e) => e?.resource?.resourceType === 'Patient')?.resource?.id
      }
    );
    return NextResponse.json(result);
  } catch (e) {
    const status = e.status || 502;
    return NextResponse.json(
      {
        error: e.message,
        body: e.body,
        mode: availityMode()
      },
      { status }
    );
  }
}
