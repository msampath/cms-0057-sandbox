import { NextResponse } from 'next/server';
import { getPendingRequest, updatePendingRequest, logTransaction } from '@/lib/db';
import { validateSubmitAttachment } from '@/lib/cdex';
import { getPatient } from '@/lib/patients';
import { reviewWindow } from '@/lib/pendedReview';
import { withUsage } from '@/lib/withUsage';

/**
 * POST /api/cdex/$submit-attachment
 *
 * Da Vinci CDex 2.1.0 $submit-attachment (system-level operation). The
 * provider answers a pended PA's attachment-request Task with the requested
 * document. When the submission is final, the pended request re-enters
 * clinical review: the demo review window starts now, and the next poll of
 * /api/pas/pended/[id] after it finalizes the decision (lib/pendedReview.js).
 */
const outcome = (status, severity, code, diagnostics) =>
  NextResponse.json({ resourceType: 'OperationOutcome', issue: [{ severity, code, diagnostics }] }, { status });

async function handlePOST(request) {
  const body = await request.json();
  const v = validateSubmitAttachment(body);
  if (!v.ok) return outcome(400, 'error', 'invalid', v.issues.join(' '));
  if (v.attachTo !== 'preauthorization') {
    return outcome(422, 'error', 'not-supported', 'This sandbox only accepts attachments for prior authorizations.');
  }

  const entry = getPendingRequest(v.trackingId);
  if (!entry) return outcome(404, 'error', 'not-found', `No pended prior authorization with TrackingId ${v.trackingId}.`);
  if (entry.status !== 'pended') {
    return outcome(409, 'error', 'conflict', `Prior authorization ${v.trackingId} is already ${entry.status}.`);
  }
  // The attachment must be for the member the request is about.
  const member = getPatient(entry.patientId);
  if (v.memberId !== entry.patientId && v.memberId !== member?.subscriberId) {
    return outcome(422, 'error', 'business-rule', `MemberId ${v.memberId} does not match the member on ${v.trackingId}.`);
  }
  // The attachment must come from the provider who asked. When the payer
  // knows the requester, ProviderId is required and must match.
  if (entry.npi && v.providerId !== entry.npi) {
    return outcome(422, 'error', 'business-rule', v.providerId
      ? `ProviderId ${v.providerId} is not the requester on ${v.trackingId}.`
      : `ProviderId is required for ${v.trackingId}, and must be the requester.`);
  }
  if ((entry.attachments || []).length + v.attachments.length > 20) {
    return outcome(422, 'error', 'too-costly', `At most 20 attachments per request.`);
  }
  // A final attachment already started clinical review. Another submission
  // must not restart the review window.
  if (!entry.awaitingAttachment) {
    return outcome(409, 'error', 'conflict', `Attachment for ${v.trackingId} already received; clinical review is in progress.`);
  }

  const attachments = [...(entry.attachments || []), ...v.attachments];
  updatePendingRequest(v.trackingId, {
    attachments,
    ...(v.final ? { awaitingAttachment: false, decideAfter: Date.now() + reviewWindow() } : {})
  });

  logTransaction(
    'CDex Gateway',
    'CDEX ATTACHMENT RECEIVED',
    `$submit-attachment for Auth # ${v.trackingId}: ${v.attachments.length} attachment(s) (${v.attachments.map((a) => `LOINC ${a.code || '-'} as ${a.contentType}`).join(', ')}). ${
      v.final ? 'Final submission: the request re-enters clinical review.' : 'Not final: more attachments expected.'
    }`,
    { patientId: entry.patientId, npi: entry.npi || null }
  );

  return outcome(
    200,
    'information',
    'informational',
    v.final
      ? `Attachment received for ${v.trackingId}. The prior authorization is back in clinical review.`
      : `Attachment received for ${v.trackingId}. Waiting for the final submission.`
  );
}

// Usage metrics (CMS-0062-P): one event per call, bucketed by outcome.
export const POST = withUsage('Prior Authorization', handlePOST);
