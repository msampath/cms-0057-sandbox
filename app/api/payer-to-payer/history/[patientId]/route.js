import { NextResponse } from 'next/server';
import { PRIOR_PLAN_HISTORY } from '@/lib/patients';
import { buildEob, CARIN_PROFILES } from '@/lib/eob';
import { PAS_PROFILES } from '@/lib/fhir';

/**
 * Prior plan history for a matched member, returned as a FHIR searchset
 * Bundle: one prior-plan Coverage (status cancelled, period.end =
 * disenrollment), one ClaimResponse per prior authorization
 * (use: preauthorization, preAuthRef/preAuthPeriod, denials via error[]
 * and processNote), and one CARIN BB ExplanationOfBenefit per claim row.
 *
 * In production this payload would be retrieved via bulk FHIR ($export on
 * the Group returned after $member-match), and prior authorizations would
 * more likely use the PDex prior-authorization EOB profile
 * (http://hl7.org/fhir/us/davinci-pdex/StructureDefinition/pdex-priorauthorization).
 * The shapes here stay within core R4 + PAS + CARIN BB so the demo reuses
 * one EOB generator across Patient Access and P2P.
 */

const CLAIM_TYPE = 'http://terminology.hl7.org/CodeSystem/claim-type';
const ADJUDICATION = 'http://terminology.hl7.org/CodeSystem/adjudication';
const CPT = 'http://www.ama-assn.org/go/cpt';

function priorPaToClaimResponse(pa, patientId, priorPayer) {
  const notes = [];
  if (pa.approvedUnits) {
    notes.push(
      `Approved: ${pa.approvedUnits} ${pa.unitType || 'unit(s)'}${pa.expiryDate ? `, valid through ${pa.expiryDate}` : ''}.`
    );
  }
  if (pa.appealRights) notes.push(`Appeal rights: ${pa.appealRights}`);

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
    outcome: pa.status === 'approved' ? 'complete' : 'error',
    disposition: pa.description,
    preAuthRef: pa.authNumber,
    addItem: [
      {
        productOrService: {
          coding: [{ system: CPT, code: pa.serviceCode }],
          text: pa.description
        },
        adjudication: [
          { category: { coding: [{ system: ADJUDICATION, code: 'submitted' }] } }
        ]
      }
    ]
  };

  if (pa.expiryDate) {
    cr.preAuthPeriod = { start: pa.decisionDate, end: pa.expiryDate };
  }
  if (pa.status !== 'approved') {
    cr.error = [
      {
        code: {
          coding: [
            {
              system: 'urn:payer:prior:denial-code',
              code: pa.denialCode || 'DENIED'
            }
          ],
          text: pa.denialReason || 'Denied by prior payer.'
        }
      }
    ];
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

  const resources = [priorCoverage, ...claimResponses, ...eobs];

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
