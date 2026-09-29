import { NextResponse } from 'next/server';
import { PRIOR_PLAN_HISTORY, PATIENT_ID_BY_SUBSCRIBER } from '@/lib/patients';
import { requireScopes } from '@/lib/auth';
import { withUsage } from '@/lib/withUsage';

// System scopes the new payer's backend service presents when calling the
// prior payer.
const REQUIRED_SCOPES = ['system/Patient.read', 'system/Coverage.read'];

// Simulated $member-match endpoint (PDex STU 2.0, §4.2).
// Accepts a FHIR Parameters body containing MemberPatient + CoverageToMatch.
// Returns a Parameters response with the matched member identifier.

// Also allow matching by patientId directly (demo convenience).
const ALL_PATIENT_IDS = Object.keys(PRIOR_PLAN_HISTORY);

async function handlePOST(request) {
  const denied = requireScopes(request, REQUIRED_SCOPES);
  if (denied) return denied;

  const body = await request.json();

  // Extract MemberPatient and CoverageToMatch from the Parameters bundle.
  const params = Array.isArray(body?.parameter) ? body.parameter : [];
  const memberPatientParam = params.find((p) => p?.name === 'MemberPatient');
  const coverageParam = params.find((p) => p?.name === 'CoverageToMatch');

  const memberPatient = memberPatientParam?.resource;
  const coverageToMatch = coverageParam?.resource;

  // Match by subscriberId in the Coverage resource, then fall back to
  // the patient id string directly (for the demo UI convenience path).
  let matchedPatientId = null;

  if (typeof coverageToMatch?.subscriberId === 'string' && Object.hasOwn(PATIENT_ID_BY_SUBSCRIBER, coverageToMatch.subscriberId)) {
    matchedPatientId = PATIENT_ID_BY_SUBSCRIBER[coverageToMatch.subscriberId];
    // This payer is the prior payer here, so only a member it holds prior
    // coverage for can match. Otherwise the history call would 404.
    if (!Object.hasOwn(PRIOR_PLAN_HISTORY, matchedPatientId)) matchedPatientId = null;
  }
  if (!matchedPatientId && memberPatient?.id && ALL_PATIENT_IDS.includes(memberPatient.id)) {
    matchedPatientId = memberPatient.id;
  }

  if (!matchedPatientId) {
    return NextResponse.json(
      {
        resourceType: 'OperationOutcome',
        issue: [{
          severity: 'error',
          code: 'not-found',
          diagnostics: 'No member record found matching the supplied Coverage and Patient demographics.',
        }],
      },
      { status: 422 }
    );
  }

  const history = PRIOR_PLAN_HISTORY[matchedPatientId];

  // Pure Parameters response per the HRex $member-match operation: the
  // caller reads MemberIdentifier.valueIdentifier.value and uses it for
  // subsequent history queries. No convenience fields outside the spec
  // shape. In this demo the prior payer's member identifier is the demo
  // patient id.
  return NextResponse.json({
    resourceType: 'Parameters',
    parameter: [
      {
        name: 'MemberIdentifier',
        valueIdentifier: {
          system: `urn:payer:${(history?.priorPayer || 'prior-payer').toLowerCase().replace(/\s+/g, '-')}:member`,
          value: matchedPatientId,
        },
      },
      {
        name: 'ConsentDateTime',
        valueDateTime: new Date().toISOString(),
      },
      {
        name: 'DemoNote',
        valueString: 'Consent on file via enrollment form. Production would require a FHIR Consent resource or an out-of-band member authorization.',
      },
    ],
  });
}

// Usage metrics (CMS-0062-P): one event per call, bucketed by outcome.
export const POST = withUsage('Payer-to-Payer', handlePOST);
