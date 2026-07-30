import { NextResponse } from 'next/server';
import { fetchEpicPatient, epicBackendMode } from '@/lib/epicBackend';
import { logTransaction } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Epic Backend Services outbound endpoint.
 *
 * GET /api/epic/patient?id=<Epic FHIR patient id>
 *
 * A query param rather than a [id] dynamic segment, to sidestep this
 * repo's prior Windows/PowerShell friction with bracket route segments.
 *
 * Response: { mode, assertionClaims, patient } where patient is a FHIR
 * Patient resource (real, from Epic's public sandbox, or canned) and mode
 * is 'live' | 'mock-no-credentials' | 'mock-forced' | 'disabled'.
 */
export async function GET(request) {
  const fhirId = request.nextUrl.searchParams.get('id');
  if (!fhirId) {
    return NextResponse.json({ error: 'Query param "id" is required' }, { status: 400 });
  }

  try {
    const result = await fetchEpicPatient(fhirId);
    const patientName = result.patient?.name?.[0]
      ? [result.patient.name[0].given?.join(' '), result.patient.name[0].family]
          .filter(Boolean)
          .join(' ')
      : null;
    logTransaction(
      'EPIC',
      'BACKEND PATIENT READ',
      { mode: result.mode, patientName },
      { patientId: fhirId }
    );
    return NextResponse.json(result);
  } catch (e) {
    const status = e.status || 502;
    return NextResponse.json(
      {
        error: e.message,
        body: e.body,
        mode: epicBackendMode()
      },
      { status }
    );
  }
}
