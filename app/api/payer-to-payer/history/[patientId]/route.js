import { NextResponse } from 'next/server';
import { PRIOR_PLAN_HISTORY } from '@/lib/patients';
import { buildEob, buildPriorAuthEob, CARIN_PROFILES } from '@/lib/eob';
import { DRUG_CATALOG, DRUG_DENIAL_REASONS } from '@/lib/drugPa';
import {
  PAS_PROFILES,
  REVIEW_ACTIONS,
  REVIEW_REASONS,
  reviewAdjudication
} from '@/lib/fhir';
import { requireScopes } from '@/lib/auth';
import { withUsage } from '@/lib/withUsage';

const REQUIRED_SCOPES = [
  'system/Coverage.read',
  'system/ClaimResponse.read',
  'system/ExplanationOfBenefit.read'
];

/**
 * Prior plan history for a matched member, returned as a FHIR searchset
 * Bundle: one prior-plan Coverage (status cancelled, period.end =
 * disenrollment), one ClaimResponse per prior authorization
 * (use: preauthorization, preAuthRef/preAuthPeriod, the PAS reviewAction
 * extension on addItem.adjudication carrying the X12 306 action and 886
 * reason, appeal rights in processNote), and one CARIN BB
 * ExplanationOfBenefit per claim row.
 *
 * In production this payload would be retrieved via bulk FHIR ($export on
 * the Group returned after $member-match), and prior authorizations would
 * more likely use the PDex prior-authorization EOB profile
 * (http://hl7.org/fhir/us/davinci-pdex/StructureDefinition/pdex-priorauthorization).
 * The shapes here stay within core R4 + PAS + CARIN BB so the demo reuses
 * one EOB generator across Patient Access and P2P.
 */

const CLAIM_TYPE = 'http://terminology.hl7.org/CodeSystem/claim-type';
const CPT = 'http://www.ama-assn.org/go/cpt';

function priorPaToClaimResponse(pa, patientId, priorPayer) {
  const notes = [];
  if (pa.approvedUnits) {
    notes.push(
      `Approved: ${pa.approvedUnits} ${pa.unitType || 'unit(s)'}${pa.expiryDate ? `, valid through ${pa.expiryDate}` : ''}.`
    );
  }
  if (pa.appealRights) notes.push(`Appeal rights: ${pa.appealRights}`);

  const approved = pa.status === 'approved';
  const reason = Object.values(REVIEW_REASONS).find((r) => r.code === pa.denialCode);
  const review = approved
    ? { action: REVIEW_ACTIONS.certified, number: pa.authNumber }
    : {
        action: REVIEW_ACTIONS.notCertified,
        number: pa.authNumber,
        reason,
        reasonText: pa.denialReason || 'Denied by prior payer.'
      };

  const cr = {
    resourceType: 'ClaimResponse',
    id: `prior-pa-${pa.authNumber.toLowerCase()}`,
    meta: { profile: [PAS_PROFILES.claimResponse] },
    status: 'active',
    type: { coding: [{ system: CLAIM_TYPE, code: 'professional' }] },
    use: 'preauthorization',
    patient: { reference: `Patient/${patientId}` },
    created: `${pa.decisionDate}T12:00:00Z`,
    insurer: { display: priorPayer },
    outcome: 'complete',
    disposition: pa.description,
    preAuthRef: pa.authNumber,
    addItem: [
      {
        itemSequence: [1],
        productOrService: {
          coding: [{ system: CPT, code: pa.serviceCode }],
          text: pa.description
        },
        adjudication: [reviewAdjudication(review)]
      }
    ]
  };

  if (pa.expiryDate) {
    cr.preAuthPeriod = { start: pa.decisionDate, end: pa.expiryDate };
  }
  if (notes.length) {
    cr.processNote = notes.map((text, i) => ({
      number: i + 1,
      type: 'display',
      text
    }));
  }
  return cr;
}

async function handleGET(request, { params }) {
  const denied = requireScopes(request, REQUIRED_SCOPES);
  if (denied) return denied;

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

  const priorCoverage = {
    resourceType: 'Coverage',
    id: `prior-coverage-${patientId}`,
    meta: { profile: [CARIN_PROFILES.coverage] },
    status: 'cancelled',
    beneficiary: { reference: `Patient/${patientId}` },
    payor: [{ display: history.priorPayer }],
    class: [
      {
        type: {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/coverage-class',
              code: 'plan'
            }
          ]
        },
        value: history.priorPlanId,
        name: history.priorPlanName
      }
    ],
    period: { end: history.disenrollmentDate }
  };

  const claimResponses = history.priorPAs.map((pa) =>
    priorPaToClaimResponse(pa, patientId, history.priorPayer)
  );

  const eobs = history.eobSummary.map((row, i) =>
    buildEob({
      id: `prior-eob-${patientId.slice(4, 8)}-${i}`,
      patientId,
      coverageRef: `Coverage/prior-coverage-${patientId}`,
      payerDisplay: history.priorPayer,
      row
    })
  );

  // Prior-payer drug PAs as PDex Prior Authorization EOBs. CMS-0062-P
  // proposes removing the CMS-0057-F drug exclusion from Payer-to-Payer.
  const drugPaEobs = (history.priorDrugPAs || [])
    .filter((pa) => DRUG_CATALOG[pa.drugKey])
    .map((pa) =>
      buildPriorAuthEob({
        record: {
          patientId,
          drugKey: pa.drugKey,
          tracks: {
            [pa.track]: {
              determination: pa.status,
              reasonKey: pa.reasonKey || null,
              [pa.track === 'medical' ? 'authNumber' : 'caseId']: pa.authNumber,
              at: `${pa.decisionDate}T12:00:00Z`
            }
          }
        },
        track: pa.track,
        drug: DRUG_CATALOG[pa.drugKey],
        reason: pa.reasonKey ? DRUG_DENIAL_REASONS[pa.reasonKey] : null,
        coverageRef: `Coverage/prior-coverage-${patientId}`,
        payerDisplay: history.priorPayer,
        // The prior payer's prescriber is not part of this exchange, so a
        // display-only reference avoids an unresolvable Practitioner link.
        practitionerRef: null,
        providerDisplay: `Prescriber on file with ${history.priorPayer}`
      })
    );

  const resources = [priorCoverage, ...claimResponses, ...drugPaEobs, ...eobs];

  return NextResponse.json({
    resourceType: 'Bundle',
    id: `p2p-history-${patientId}`,
    type: 'searchset',
    timestamp: new Date().toISOString(),
    total: resources.length,
    entry: resources.map((resource) => ({
      fullUrl: `urn:uuid:${crypto.randomUUID()}`,
      resource
    }))
  });
}

// Usage metrics (CMS-0062-P): one event per call, bucketed by outcome.
export const GET = withUsage('Payer-to-Payer', handleGET);
