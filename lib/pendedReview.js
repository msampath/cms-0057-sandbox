import { getPendingRequest, finalizePendingRequest, logTransaction } from './db';
import { wrapPasResponseBundle, PAS_PROFILES } from './fhir';

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

const CRD_TEMP = 'http://hl7.org/fhir/us/davinci-crd/CodeSystem/temp';
const COV_EXT =
  'http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information';
const CPT = 'http://www.ama-assn.org/go/cpt';

export function reviewWindow() {
  return REVIEW_WINDOW_MS;
}

export function finalizePendedIfDue(id) {
  const entry = getPendingRequest(id);
  if (!entry || entry.status !== 'pended') return entry;
  if (Date.now() < (entry.decideAfter || 0)) return entry;

  const { authNumber, vendor, patientId, orderedCode } = entry;
  const now = new Date().toISOString();

  const finalAction = {
    type: 'update',
    description:
      'Coverage information updated — PA determination finalized after clinical review',
    resource: {
      resourceType: 'Task',
      status: 'completed',
      intent: 'proposal',
      code: { coding: [{ system: CRD_TEMP, code: 'coverage-information' }] },
      for: { reference: `Patient/${patientId}` },
      authoredOn: now,
      extension: [
        { url: `${COV_EXT}#covered`, valueCode: 'covered' },
        { url: `${COV_EXT}#pa-needed`, valueCode: 'satisfied' },
        {
          url: `${COV_EXT}#billingCode`,
          valueCoding: { system: CPT, code: orderedCode || '' }
        },
        { url: `${COV_EXT}#date`, valueDateTime: now },
        { url: `${COV_EXT}#satisfied-pa-id`, valueString: authNumber }
      ]
    }
  };

  const finalClaimResponse = {
    resourceType: 'ClaimResponse',
    id: `cr-final-${Date.now()}`,
    meta: { profile: [PAS_PROFILES.claimResponse] },
    status: 'active',
    type: {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/claim-type',
          code: 'institutional'
        }
      ]
    },
    use: 'preauthorization',
    patient: { reference: `Patient/${patientId}` },
    outcome: 'complete',
    disposition: `Prior Authorization Approved by ${vendor}. Functional impairment criteria met on clinical review.`,
    preAuthRef: authNumber,
    insurer: { display: vendor }
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
    { patientId }
  );
  logTransaction(
    'PAS Gateway',
    'REST-HOOK NOTIFICATION',
    `Subscription notification fired to EHR rest-hook endpoint per R4 Subscriptions Backport IG.\n\n${JSON.stringify(finalBundle, null, 2)}`,
    { patientId }
  );

  return getPendingRequest(id);
}
