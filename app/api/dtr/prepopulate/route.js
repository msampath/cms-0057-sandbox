import { NextResponse } from 'next/server';
import { bodyTooLarge } from '@/lib/bodyLimit';
import { outboundRateLimit } from '@/lib/rateLimit';
import { fetchEpicPatientBundle, epicBackendMode } from '@/lib/epicBackend';
import { evaluateCqlLibrary, listCqlLibraries } from '@/lib/cql';
import { logTransaction } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * DTR pre-population via CQL against Epic-fetched FHIR data.
 *
 * POST /api/dtr/prepopulate
 * Body: { epicPatientId: string, libraryId?: string }
 *   libraryId defaults to 'MRIBrainPrepopulation'.
 *
 * Flow:
 *   1. Fetch the patient's Bundle from Epic (Patient + Condition +
 *      Observation), via lib/epicBackend.js. Mock modes return a canned
 *      Bundle so the demo works with zero credentials.
 *   2. Execute the CQL library locally against that Bundle
 *      (lib/cql.js wraps cql-execution + cql-exec-fhir).
 *   3. Return { mode, assertionClaims, results, bundleSummary, warnings }.
 *
 * results maps CQL define names -> evaluated values (strings, booleans,
 * or plain objects). The /ehr DTR pane maps these to questionnaire
 * linkIds and marks the prefilled fields.
 */
export async function POST(request) {
  const oversized = bodyTooLarge(request, 64 * 1024);
  if (oversized) return oversized;
  const limited = outboundRateLimit('Epic', epicBackendMode());
  if (limited) return limited;
  let body = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
  }
  const epicPatientId = body?.epicPatientId;
  const libraryId = body?.libraryId || 'MRIBrainPrepopulation';

  if (!epicPatientId || typeof epicPatientId !== 'string') {
    return NextResponse.json(
      { error: 'epicPatientId is required', knownLibraries: listCqlLibraries() },
      { status: 400 }
    );
  }
  // Check the library before any upstream call is spent.
  if (!listCqlLibraries().includes(libraryId)) {
    return NextResponse.json(
      { error: `Unknown CQL library: ${libraryId}`, knownLibraries: listCqlLibraries() },
      { status: 404 }
    );
  }

  try {
    const { mode, assertionClaims, bundle, warnings } = await fetchEpicPatientBundle(epicPatientId);
    const evalResult = await evaluateCqlLibrary(libraryId, bundle);

    const bundleSummary = {
      totalEntries: bundle?.entry?.length || 0,
      byResourceType: (bundle?.entry || []).reduce((acc, e) => {
        const rt = e?.resource?.resourceType || 'unknown';
        acc[rt] = (acc[rt] || 0) + 1;
        return acc;
      }, {})
    };

    logTransaction(
      'EPIC',
      'CQL PREPOPULATION',
      {
        mode,
        libraryId,
        defines: Object.keys(evalResult.results).length,
        resources: bundleSummary.totalEntries
      },
      { patientId: epicPatientId }
    );

    return NextResponse.json({
      mode,
      libraryId,
      epicPatientId,
      assertionClaims,
      results: evalResult.results,
      bundleSummary,
      warnings: warnings || []
    });
  } catch (e) {
    const status = e.status || 502;
    return NextResponse.json(
      { error: e.message, body: e.body, mode: epicBackendMode() },
      { status }
    );
  }
}
