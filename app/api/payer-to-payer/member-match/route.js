import { NextResponse } from 'next/server';
import { PRIOR_PLAN_HISTORY } from '@/lib/db';

// Simulated $member-match endpoint (PDex STU 2.0, §4.2).
// Accepts a FHIR Parameters body containing MemberPatient + CoverageToMatch.
// Returns a Parameters response with the matched member identifier.

const PATIENT_ID_BY_SUBSCRIBER = {
  'BCBSIL-MEM-849': 'pat-8849-jane-doe',
  'BCBSIL-MEM-712': 'pat-7712-robert-chen',
  'BCBSIL-MEM-301': 'pat-3301-dorothy-hayes',
  'BCBSIL-MEM-614': 'pat-6614-marcus-johnson',
};

// Also allow matching by patientId directly (demo convenience).
const ALL_PATIENT_IDS = Object.keys(PRIOR_PLAN_HISTORY);

export async function POST(request) {
  const body = await request.json();

  // Extract MemberPatient and CoverageToMatch from the Parameters bundle.
  const params = body?.parameter || [];
  const memberPatientParam = params.find((p) => p.name === 'MemberPatient');
  const coverageParam = params.find((p) => p.name === 'CoverageToMatch');

  const memberPatient = memberPatientParam?.resource;
  const coverageToMatch = coverageParam?.resource;

  // Match by subscriberId in the Coverage resource, then fall back to
  // the patient id string directly (for the demo UI convenience path).
  let matchedPatientId = null;

  if (coverageToMatch?.subscriberId) {
    matchedPatientId = PATIENT_ID_BY_SUBSCRIBER[coverageToMatch.subscriberId] || null;
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

  // Return matched member identifier per PDex $member-match response shape.
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
        name: '_demo_note',
        valueString: 'Consent on file via enrollment form. Production would require a FHIR Consent resource or an out-of-band member authorization.',
      },
    ],
    _matchedPatientId: matchedPatientId,
    _priorPayer: history?.priorPayer || null,
  });
}
