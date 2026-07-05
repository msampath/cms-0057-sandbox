import { NextResponse } from 'next/server';
import { PRIOR_PLAN_HISTORY } from '@/lib/db';

// Returns seeded prior-plan clinical history for a matched member.
// In production this would be the result of a FHIR $export on the
// Group resource returned by the prior payer after $member-match.

export async function GET(request, { params }) {
  const { patientId } = params;
  const history = PRIOR_PLAN_HISTORY[patientId];

  if (!history) {
    return NextResponse.json(
      {
        resourceType: 'OperationOutcome',
        issue: [{
          severity: 'error',
          code: 'not-found',
          diagnostics: `No prior-plan history found for member ${patientId}.`,
        }],
      },
      { status: 404 }
    );
  }

  return NextResponse.json({
    patientId,
    priorPayer: history.priorPayer,
    priorPlanId: history.priorPlanId,
    priorPlanName: history.priorPlanName,
    disenrollmentDate: history.disenrollmentDate,
    priorAuthorizations: history.priorPAs,
    eobSummary: history.eobSummary,
    _demo_note: 'In production this payload would be retrieved via FHIR $export on the Group resource returned by the prior payer. Bulk FHIR (NDJSON) is the expected transport for member histories of this size.',
  });
}
