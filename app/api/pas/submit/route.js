import { NextResponse } from 'next/server';
import { getDb, logTransaction, addPendingRequest, upsertDrugPaRecord, nextRequestId } from '@/lib/db';
import { resolveRouting, claimDiagnosisCodes } from '@/lib/routing';
import {
  DRUG_BY_HCPCS,
  DRUG_DENIAL_REASONS,
  answersFromQuestionnaireResponse,
  decideDrugPa
} from '@/lib/drugPa';
import {
  PAS_PROFILES,
  REVIEW_ACTIONS,
  REVIEW_REASONS,
  X12_REJECT_REASONS,
  claimTypeOf,
  claimResponseItems,
  coverageInformationOrder,
  pasErrorClaimResponse,
  wrapPasResponseBundle
} from '@/lib/fhir';
import { reviewWindow } from '@/lib/pendedReview';
import { getPatient, PATIENT_LIST } from '@/lib/patients';
import { buildAttachmentRequestTask, ATTACHMENT_NEEDED } from '@/lib/cdex';
import { apiBase } from '@/lib/origin';
import { decisionClock, formatClockHours } from '@/lib/decisionClock';
import {
  generateX12_278,
  generateX12_278_Response,
  getReceiverId
} from '../x12Generator';
import { withUsage } from '@/lib/withUsage';

/**
 * PAS submit endpoint.
 *
 * Accepts a FHIR `Bundle` (type=collection, per the PAS request Bundle profile). The Bundle is preserved
 * unaltered (Da Vinci PAS "unaltered FHIR Bundle" strategy) and a
 * parallel X12 278 projection is generated for the legacy adjudication
 * engine. Both are emitted to the UM live feed together so the field-to-
 * segment mapping is inspectable in real time.
 *
 * On the response side: a mock X12 278 Response is synthesized, the FHIR
 * `ClaimResponse` is built directly from the original Bundle + the auth
 * number (no FHIR→X12→FHIR round-trip), and a `coverage-information`
 * system action with `pa-needed: "satisfied"` is returned.
 */

function pickEntry(bundle, type) {
  if (!Array.isArray(bundle?.entry)) return null;
  const hit = bundle.entry.find((e) => e?.resource?.resourceType === type);
  return hit ? hit.resource : null;
}

function ruleMatchesPlan(rule, planType) {
  if (rule.plan_type) return rule.plan_type === planType;
  const label = (rule.source_label || '').toLowerCase();
  if (!label) return true;
  const isMa = label.includes('medicare');
  if (planType === 'MA-PPO') return isMa || (!label.includes('commercial') && !label.includes('medsurg') && !label.includes('med-surg') && !label.includes('med surg'));
  // QHP individual-market coverage uses the commercial grids.
  if (planType === 'COMM-PPO' || planType === 'COMM-HMO' || planType === 'QHP-FFE') return !isMa;
  // No Medicaid PA grid is ingested, so no grid rule applies to Medicaid.
  if (planType === 'MEDICAID-MCO') return false;
  return true;
}

function findRule(rules, orderedCode, serviceCategory) {
  if (orderedCode) {
    const byCode = rules.find(
      (r) => r.match_type === 'code' && r.service_code === orderedCode
    );
    if (byCode) return byCode;
  }
  if (serviceCategory) {
    const needle = serviceCategory.toLowerCase();
    return (
      rules.find(
        (r) =>
          r.match_type === 'category' &&
          r.service_category &&
          (r.service_category.toLowerCase().includes(needle) ||
            needle.includes(r.service_category.toLowerCase()))
      ) || null
    );
  }
  return null;
}

function practitionerNpiOf(bundle) {
  const ids = pickEntry(bundle, 'Practitioner')?.identifier;
  const v = (Array.isArray(ids) ? ids : []).find((i) => i?.system === 'http://hl7.org/fhir/sid/us-npi')?.value;
  return typeof v === 'string' && v ? v : null;
}

export async function handlePOST(request) {
  const bundle = await request.json();

  const claim = pickEntry(bundle, 'Claim');
  const patient = pickEntry(bundle, 'Patient');
  const coverage = pickEntry(bundle, 'Coverage');
  const str = (v) => (typeof v === 'string' && v ? v : null);
  const firstItem = Array.isArray(claim?.item) ? claim.item[0] : null;
  const orderedCode =
    str(firstItem?.productOrService?.coding?.[0]?.code) ||
    str(bundle.serviceCode) ||
    null;
  const serviceCategory =
    str(firstItem?.productOrService?.text) || str(bundle.serviceCategory) || null;
  const claimType = claimTypeOf(claim);
  const coverageId = str(coverage?.id) || getPatient(patient?.id)?.coverageId || null;
  // The EHR sends the plan it is ordering under (its plan selector lets a
  // demo run one patient under another plan's rules). A Bundle without one
  // falls back to the member's own plan, so a conformant PAS client that
  // omits the sandbox field still gets the right rules and decision clock.
  const planType = bundle.planType || getPatient(patient?.id)?.planType || null;
  // Only a plan this payer knows gets its rules, clock, and metrics row.
  const knownPlans = [...(getDb().plans || []).map((p) => p.plan_type), ...PATIENT_LIST.map((p) => p.planType)];
  if (planType !== null && !knownPlans.includes(planType)) {
    return NextResponse.json(
      { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'value', diagnostics: `Unknown planType. Known: ${[...new Set(knownPlans)].join(', ')}.` }] },
      { status: 400 }
    );
  }

  logTransaction(
    'PAS Gateway',
    'BUNDLE RECEIVED',
    `FHIR Bundle (type=${bundle.type || '—'}) for Patient/${patient?.id || 'unknown'}, code=${orderedCode || '—'}. Bundle preserved unaltered.`,
    { patientId: patient?.id || 'unknown' }
  );

  // Validation error: without a Claim and a Patient there is nothing to
  // adjudicate. This is the only path that uses outcome 'error' and the
  // X12 AAA segment. Clinical decisions go through HCR below.
  if (!claim || !patient) {
    const missing = [!claim && 'Claim', !patient && 'Patient'].filter(Boolean).join(' and ');
    const rejectReason = X12_REJECT_REASONS.requiredDataMissing;
    const receiverId = getReceiverId('BCBSIL');

    logTransaction('PAS Gateway', 'X12 278 RESPONSE (VALIDATION ERROR)',
      `Request rejected before adjudication. AAA*N, reason ${rejectReason.code} ${rejectReason.display}. Bundle has no ${missing}.\n\n${generateX12_278_Response({
        receiverId,
        action: 'AAA',
        reasonCode: rejectReason.code
      })}`,
      { patientId: patient?.id || 'unknown' }
    );

    return NextResponse.json(
      wrapPasResponseBundle([
        pasErrorClaimResponse({
          patientId: patient?.id || 'unknown',
          insurer: 'BCBSIL',
          reason: rejectReason,
          claimType,
          text: `PAS request Bundle has no ${missing} entry.`
        })
      ])
    );
  }

  const db = getDb();
  const rules = planType ? db.rules.filter((r) => ruleMatchesPlan(r, planType)) : db.rules;
  const rule = findRule(rules, orderedCode, serviceCategory);
  const { vendor } = resolveRouting(rule, claimDiagnosisCodes(claim));

  // Generate the X12 278 alongside the Bundle (parallel projection, not a
  // destructive conversion).
  const { x12, mappings } = generateX12_278({
    bundle,
    rule,
    vendor,
    orderedCode
  });

  // Structured log: the UM Dashboard renders this with the inline FHIR↔X12
  // translation drawer. The bundle is included verbatim (unaltered).
  logTransaction('PAS Gateway', 'X12 278 REQUEST', {
    kind: 'fhir-x12-translation',
    vendor,
    bundle,
    x12,
    mappings,
    note: 'Bundle preserved unaltered; X12 is a parallel projection for the legacy adjudication engine.'
  });

  // Drug orders are decided by the shared drug PA model (lib/drugPa.js),
  // the same function the pharmacy (NCPDP) track calls, from the DTR
  // QuestionnaireResponse answers. The result lands in the shared record.
  const drugKey = Object.hasOwn(DRUG_BY_HCPCS, String(orderedCode)) ? DRUG_BY_HCPCS[orderedCode] : null;

  // Legal decision clock (lib/decisionClock.js). Expedited when the Claim
  // priority is stat. Logged with each decision so the UM feed can show it.
  const expedited = claim?.priority?.coding?.[0]?.code === 'stat';
  const receivedAt = new Date().toISOString();
  const clock = decisionClock({ planType, isDrug: !!drugKey, benefit: 'medical', expedited, receivedAt });
  const drugQr = drugKey ? pickEntry(bundle, 'QuestionnaireResponse') : null;
  const drugAnswers = drugKey ? answersFromQuestionnaireResponse(drugQr) : null;
  const drugDecision = drugKey ? decideDrugPa(drugKey, drugAnswers) : null;
  const drugReason = drugDecision?.reasonKey ? DRUG_DENIAL_REASONS[drugDecision.reasonKey] : null;
  // Only a submission that carries DTR answers is a decision by the shared
  // model. A forced debug denial (_simulateDenial), or a Bundle with no
  // QuestionnaireResponse answers, is recorded on the medical track so the EHR card
  // and the record agree, but it does not change the shared determination
  // or answers.
  const noDrugAnswers = !!drugKey && !(drugAnswers && Object.keys(drugAnswers).length > 0);
  const recordDrugDecision = (authNumber, { forced = false } = {}) => {
    if (!drugKey) return;
    const hasAnswers = !!drugAnswers && Object.keys(drugAnswers).length > 0;
    const npi = practitionerNpiOf(bundle);
    const modelDecision = !forced && hasAnswers;
    upsertDrugPaRecord(patient?.id || 'unknown', drugKey, {
      ...(modelDecision ? { answers: drugAnswers, decision: drugDecision } : {}),
      track: 'medical',
      trackData: {
        hcpcs: orderedCode,
        npi,
        vendor,
        authNumber,
        determination: forced ? 'denied' : drugDecision.determination,
        reasonKey: forced ? null : drugDecision.reasonKey,
        ...(forced ? { debugForced: true } : {}),
        ...(!forced && !hasAnswers ? { noAnswers: true } : {})
      }
    });
  };

  // Denials: the _simulateDenial debug flag from the EHR, or a drug
  // decision that did not meet criteria.
  if (bundle._simulateDenial || drugDecision?.determination === 'denied') {
    const authNumber = nextRequestId('DENY');
    const receiverId = getReceiverId(vendor);
    const reason = drugReason ? drugReason.x12 : REVIEW_REASONS.notMedicallyNecessary;
    // A genuine model denial is recorded as such. A debug denial of a
    // request the model would approve is recorded as forced.
    recordDrugDecision(authNumber, { forced: drugDecision?.determination !== 'denied' });

    const x12Denial = generateX12_278_Response({
      receiverId,
      authNumber,
      action: REVIEW_ACTIONS.notCertified.code,
      reasonCode: reason.code
    });

    logTransaction('Legacy UM Mainframe', 'X12 278 RESPONSE (DENIAL)',
      `Decision: DENIED. HCR*A3, reason ${reason.code} ${reason.display}.\n\n${x12Denial}`,
      { patientId: patient?.id || 'unknown' }
    );

    const deniedClaimResponse = {
      resourceType: 'ClaimResponse',
      id: `cr-${Date.now()}`,
      meta: { profile: [PAS_PROFILES.claimResponse] },
      status: 'active',
      type: claimType,
      use: 'preauthorization',
      patient: { reference: `Patient/${patient?.id || 'unknown'}` },
      created: new Date().toISOString(),
      outcome: 'complete',
      disposition: drugReason
        ? `Prior Authorization Denied by ${vendor}. ${drugReason.text}.`
        : `Prior Authorization Denied by ${vendor}. Service does not meet clinical criteria for medical necessity.`,
      preAuthRef: authNumber,
      insurer: { display: vendor },
      item: claimResponseItems(claim, {
        action: REVIEW_ACTIONS.notCertified,
        number: authNumber,
        reason,
        reasonText: drugReason
          ? `${drugReason.text}. Appeal rights apply within 60 days of this determination.`
          : `The requested service (${orderedCode || 'service'}) does not meet ${vendor} clinical criteria for medical necessity. Functional impairment or clinical indication documentation submitted is insufficient under policy MED-0472. Appeal rights apply within 60 days of this determination.`
      })
    };

    const deniedAction = {
      type: 'update',
      description: 'Coverage information updated — PA denied',
      resource: coverageInformationOrder({
        patientId: patient?.id,
        orderedCode,
        serviceText: serviceCategory,
        coverageId,
        covered: 'covered',
        paNeeded: 'auth-needed'
      })
    };

    logTransaction('PAS Gateway', 'COVERAGE-INFORMATION ACTION (DENIAL)',
      JSON.stringify(deniedAction.resource, null, 2),
      { patientId: patient?.id || 'unknown' }
    );
    logTransaction('PAS Translator', 'FHIR RESPONSE (DENIAL)',
      `ClaimResponse: outcome=complete, reviewAction A3 Not Certified, reason ${reason.code} ${reason.display} (X12 886). Appeal period: 60 days.`,
      {
        patientId: patient?.id || 'unknown',
        clock,
        decidedAt: new Date().toISOString(),
        // PA metrics tag. A debug denial of a request the model would
        // approve is not a decision, so it is marked forced.
        pa: {
          requestId: authNumber,
          category: drugKey ? 'drug' : 'item',
          benefit: 'medical',
          determination: 'denied',
          planType,
          forced: !!bundle._simulateDenial && drugDecision?.determination !== 'denied',
          noAnswers: noDrugAnswers,
          receivedAt,
          decidedAt: new Date().toISOString()
        }
      }
    );

    // Response is a PAS response Bundle: the ClaimResponse plus the order
    // carrying coverage-information as a second entry.
    return NextResponse.json(
      wrapPasResponseBundle([deniedClaimResponse, deniedAction.resource])
    );
  }

  // Blepharoplasty (15820) always pends — functional impairment review required.
  if (orderedCode === '15820') {
    const authNumber = nextRequestId('AUTH');

    const pendedClaimResponse = {
      resourceType: 'ClaimResponse',
      id: `cr-${Date.now()}`,
      meta: { profile: [PAS_PROFILES.claimResponse] },
      status: 'active',
      type: claimType,
      use: 'preauthorization',
      patient: { reference: `Patient/${patient?.id || 'unknown'}` },
      created: new Date().toISOString(),
      // PAS binds outcome to complete | error | partial. A pend is a
      // completed adjudication whose review action is A4.
      outcome: 'complete',
      disposition: `Prior authorization request is pending clinical review for functional impairment determination. Additional documentation requested (CDex attachment request). ${
        clock.applies
          ? `Decision due within ${formatClockHours(clock.hours)} (${clock.kind}, ${clock.basis}).`
          : 'No federal decision clock applies to this coverage.'
      }`,
      preAuthRef: authNumber,
      insurer: { display: vendor },
      item: claimResponseItems(claim, {
        action: REVIEW_ACTIONS.pended,
        number: authNumber
      })
    };

    logTransaction('Legacy UM Mainframe', 'X12 278 RESPONSE (PENDED)',
      `Decision: PENDED. HCR*A4. Auth # ${authNumber}.\n\n${generateX12_278_Response({
        receiverId: getReceiverId(vendor),
        authNumber,
        action: REVIEW_ACTIONS.pended.code
      })}`,
      { patientId: patient?.id || 'unknown' }
    );

    // Request-driven review clock: the decision becomes due after the
    // review window and is finalized by the next poll of
    // /api/pas/pended/[id] (lib/pendedReview.js). No background timer, so
    // the flow survives scale-to-zero hosts where CPU is only allocated
    // during requests. Production would use a durable job queue with a
    // separate worker delivering a real rest-hook notification.
    addPendingRequest(authNumber, {
      authNumber,
      vendor,
      patientId: patient?.id || 'unknown',
      orderedCode,
      // Kept so the final ClaimResponse echoes the same item sequences.
      claimItems: (Array.isArray(claim?.item) ? claim.item : []).map((it) => ({ sequence: it?.sequence })),
      coverageId,
      claimType,
      clock,
      planType,
      receivedAt,
      category: drugKey ? 'drug' : 'item',
      // Decided only after the requested attachment arrives (CDex).
      awaitingAttachment: true,
      decideAfter: null,
    });

    // CDex 2.1.0 solicited attachment: the pend asks the provider for the
    // documentation it needs, as an attachment-request Task returned in the
    // PAS response Bundle. The provider answers with $submit-attachment.
    const member = getPatient(patient?.id);
    const practitionerNpi = practitionerNpiOf(bundle) || member?.npi || 'unknown';
    const cdexTask = buildAttachmentRequestTask({
      authNumber,
      patient: {
        memberId: member?.subscriberId || patient?.id || 'unknown',
        family: member?.family || patient?.name?.[0]?.family || 'Unknown',
        given: member?.given || patient?.name?.[0]?.given || []
      },
      practitionerNpi,
      payerUrl: `${apiBase(request)}/cdex/$submit-attachment`,
      dueAt: clock.applies ? clock.dueAt : new Date(Date.now() + 72 * 3600 * 1000).toISOString()
    });
    logTransaction('CDex Gateway', 'CDEX ATTACHMENT REQUESTED',
      `Auth # ${authNumber}: attachment-request Task asks for LOINC ${ATTACHMENT_NEEDED.code} (${ATTACHMENT_NEEDED.display}) via $submit-attachment.\n\n${JSON.stringify(cdexTask, null, 2)}`,
      { patientId: patient?.id || 'unknown' }
    );

    logTransaction('PAS Gateway', 'PA PENDED',
      `Auth # ${authNumber} — routed to ${vendor} clinical review queue. rest-hook notification (R4 Subscriptions Backport) will fire on determination.\n\n${JSON.stringify(pendedClaimResponse, null, 2)}`,
      {
        patientId: patient?.id || 'unknown',
        clock,
        pa: { requestId: authNumber, category: drugKey ? 'drug' : 'item', benefit: 'medical', determination: 'pended', planType, receivedAt }
      }
    );

    return NextResponse.json(wrapPasResponseBundle([pendedClaimResponse, cdexTask]));
  }

  // ---- Standard synchronous path (all other codes) -------------------------

  // Simulate mainframe latency.
  await new Promise((r) => setTimeout(r, 2500));

  const authNumber = nextRequestId('AUTH');
  recordDrugDecision(authNumber);
  const receiverId = getReceiverId(vendor);
  const x12Response = generateX12_278_Response({ receiverId, authNumber });

  logTransaction(
    'Legacy UM Mainframe',
    'X12 278 RESPONSE',
    `Decision: APPROVED. Auth # ${authNumber}.\n\n${x12Response}`,
    { patientId: patient?.id || 'unknown' }
  );

  // FHIR ClaimResponse is constructed directly from the preserved Bundle
  // + the auth number lifted from the X12 response. No round-trip.
  const claimResponse = {
    resourceType: 'ClaimResponse',
    id: `cr-${Date.now()}`,
    meta: { profile: [PAS_PROFILES.claimResponse] },
    status: 'active',
    type: claimType,
    use: 'preauthorization',
    patient: { reference: `Patient/${patient?.id || 'unknown'}` },
    created: new Date().toISOString(),
    outcome: 'complete',
    disposition: `Prior Authorization Approved by ${vendor}.`,
    preAuthRef: authNumber,
    insurer: { display: vendor },
    item: claimResponseItems(claim, {
      action: REVIEW_ACTIONS.certified,
      number: authNumber
    })
  };

  const satisfiedAction = {
    type: 'update',
    description: 'Coverage information updated post-PAS adjudication',
    resource: coverageInformationOrder({
      patientId: patient?.id,
      orderedCode,
      serviceText: serviceCategory,
      coverageId,
      covered: 'covered',
      paNeeded: 'satisfied',
      satisfiedPaId: authNumber
    })
  };

  logTransaction(
    'PAS Gateway',
    'COVERAGE-INFORMATION ACTION',
    JSON.stringify(satisfiedAction.resource, null, 2),
    { patientId: patient?.id || 'unknown' }
  );
  logTransaction(
    'PAS Translator',
    'FHIR RESPONSE',
    `ClaimResponse synthesised from preserved Bundle + auth # ${authNumber} (no FHIR→X12→FHIR round-trip).`,
    {
      patientId: patient?.id || 'unknown',
      clock,
      decidedAt: new Date().toISOString(),
      pa: {
        requestId: authNumber,
        category: drugKey ? 'drug' : 'item',
        benefit: 'medical',
        determination: 'approved',
        planType,
        noAnswers: noDrugAnswers,
        receivedAt,
        decidedAt: new Date().toISOString()
      }
    }
  );

  return NextResponse.json(
    wrapPasResponseBundle([claimResponse, satisfiedAction.resource])
  );
}

// Usage metrics (CMS-0062-P): one event per call, bucketed by outcome.
export const POST = withUsage('Prior Authorization', handlePOST);
