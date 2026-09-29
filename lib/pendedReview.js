import { getPendingRequest, finalizePendingRequest, logTransaction } from './db';
import {
  wrapPasResponseBundle,
  PAS_PROFILES,
  REVIEW_ACTIONS,
  PROFESSIONAL_CLAIM_TYPE,
  claimResponseItems,
  coverageInformationOrder
} from './fhir';

/**
 * Request-driven finalization for pended PA requests.
 *
 * The clinical-review decision "arrives" once the review window elapses
 * (eight seconds in the demo). Finalization runs lazily on the next poll
 * of /api/pas/pended/[id] rather than from a background timer, so the flow
 * survives scale-to-zero hosts (Cloud Run) where CPU is only allocated
 * while a request is in flight. In production this would be a durable job
 * queue with a separate worker delivering a real rest-hook notification;
 * here the poll that finds the decision due plays the part of the worker.
 */

const REVIEW_WINDOW_MS = 8000;


export function reviewWindow() {
  return REVIEW_WINDOW_MS;
}

export function finalizePendedIfDue(id) {
  const entry = getPendingRequest(id);
  if (!entry || entry.status !== 'pended') return entry;
  // A pend that asked for an attachment (CDex) waits for it. The review
  // window starts when the final attachment arrives
  // (app/api/cdex/$submit-attachment).
  if (entry.awaitingAttachment) return entry;
  if (Date.now() < (entry.decideAfter || 0)) return entry;

  const { authNumber, vendor, patientId, patientRef, orderedCode, claimItems, clock, coverageId, claimType } = entry;
  const now = new Date().toISOString();

  const finalAction = {
    type: 'update',
    description:
      'Coverage information updated — PA determination finalized after clinical review',
    resource: coverageInformationOrder({
      patientId,
      subjectRef: patientRef,
      orderedCode,
      coverageId,
      covered: 'covered',
      paNeeded: 'satisfied',
      satisfiedPaId: authNumber,
      date: now
    })
  };

  const finalClaimResponse = {
    resourceType: 'ClaimResponse',
    id: `cr-final-${Date.now()}`,
    meta: { profile: [PAS_PROFILES.claimResponse] },
    status: 'active',
    type: claimType || PROFESSIONAL_CLAIM_TYPE,
    use: 'preauthorization',
    patient: { reference: patientRef || `Patient/${patientId}` },
    created: new Date().toISOString(),
    outcome: 'complete',
    disposition: entry.attachments?.length
      ? `Prior Authorization Approved by ${vendor}. Functional impairment criteria met on clinical review of the submitted attachment.`
      : `Prior Authorization Approved by ${vendor}. Functional impairment criteria met on clinical review.`,
    preAuthRef: authNumber,
    insurer: { display: vendor },
    item: claimResponseItems({ item: claimItems }, {
      action: REVIEW_ACTIONS.certified,
      number: authNumber
    })
  };

  const finalBundle = wrapPasResponseBundle([
    finalClaimResponse,
    finalAction.resource
  ]);

  finalizePendingRequest(authNumber, { responseBundle: finalBundle });

  logTransaction(
    'Clinical Review Team',
    'PA APPROVED (pended → finalized)',
    `Auth # ${authNumber} — functional impairment criteria met. Determination: APPROVED.`,
    {
      patientId,
      npi: entry.npi || null,
      clock,
      decidedAt: now,
      pa: { requestId: authNumber, category: entry.category || 'item', benefit: 'medical', determination: 'approved', planType: entry.planType || null, receivedAt: entry.receivedAt || clock?.receivedAt || null, decidedAt: now }
    }
  );
  logTransaction(
    'PAS Gateway',
    'REST-HOOK NOTIFICATION',
    `Subscription notification fired to EHR rest-hook endpoint per R4 Subscriptions Backport IG.\n\n${JSON.stringify(finalBundle, null, 2)}`,
    { patientId, npi: entry.npi || null }
  );

  return getPendingRequest(id);
}
