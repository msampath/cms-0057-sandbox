import { NextResponse } from 'next/server';
import { getDb, logTransaction, addPendingRequest, upsertDrugPaRecord } from '@/lib/db';
import { resolveRouting } from '@/lib/routing';
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
  claimResponseItems,
  pasErrorClaimResponse,
  wrapPasResponseBundle
} from '@/lib/fhir';
import { reviewWindow } from '@/lib/pendedReview';
import { getPatient } from '@/lib/patients';
import { decisionClock, formatClockHours } from '@/lib/decisionClock';
import {
  generateX12_278,
  generateX12_278_Response,
  getReceiverId
} from '../x12Generator';

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
  if (!bundle?.entry) return null;
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

export async function POST(request) {
  const bundle = await request.json();

  const claim = pickEntry(bundle, 'Claim');
  const patient = pickEntry(bundle, 'Patient');
  const orderedCode =
    claim?.item?.[0]?.productOrService?.coding?.[0]?.code ||
    bundle.serviceCode ||
    null;
  const serviceCategory =
    claim?.item?.[0]?.productOrService?.text || bundle.serviceCategory || null;
  // The EHR sends the plan it is ordering under (its plan selector lets a
  // demo run one patient under another plan's rules). A Bundle without one
  // falls back to the member's own plan, so a conformant PAS client that
  // omits the sandbox field still gets the right rules and decision clock.
  const planType = bundle.planType || getPatient(patient?.id)?.planType || null;

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
          text: `PAS request Bundle has no ${missing} entry.`
        })
      ])
    );
  }

  const db = getDb();
  const rules = planType ? db.rules.filter((r) => ruleMatchesPlan(r, planType)) : db.rules;
  const rule = findRule(rules, orderedCode, serviceCategory);
  const { vendor } = resolveRouting(rule, patient);

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
  const drugKey = DRUG_BY_HCPCS[orderedCode] || null;

  // Legal decision clock (lib/decisionClock.js). Expedited when the Claim
  // priority is stat. Logged with each decision so the UM feed can show it.
  const expedited = claim?.priority?.coding?.[0]?.code === 'stat';
  const clock = decisionClock({ planType, isDrug: !!drugKey, benefit: 'medical', expedited, receivedAt: new Date().toISOString() });
  const drugQr = drugKey ? pickEntry(bundle, 'QuestionnaireResponse') : null;
  const drugAnswers = drugKey ? answersFromQuestionnaireResponse(drugQr) : null;
  const drugDecision = drugKey ? decideDrugPa(drugKey, drugAnswers) : null;
  const drugReason = drugDecision?.reasonKey ? DRUG_DENIAL_REASONS[drugDecision.reasonKey] : null;
  // Only a submission that carries DTR answers is a decision by the shared
  // model. A forced debug denial (_simulateDenial), or a Bundle with no
  // QuestionnaireResponse answers, is recorded on the medical track so the EHR card
  // and the record agree, but it does not change the shared determination
  // or answers.
  const recordDrugDecision = (authNumber, { forced = false } = {}) => {
    if (!drugKey) return;
    const hasAnswers = !!drugAnswers && Object.keys(drugAnswers).length > 0;
    const modelDecision = !forced && hasAnswers;
    upsertDrugPaRecord(patient?.id || 'unknown', drugKey, {
      ...(modelDecision ? { answers: drugAnswers, decision: drugDecision } : {}),
      track: 'medical',
      trackData: {
        hcpcs: orderedCode,
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
    const authNumber = `DENY${Date.now().toString().slice(-7)}`;
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
      type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'institutional' }] },
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
      resource: {
        resourceType: 'Task',
        status: 'completed',
        intent: 'proposal',
        code: { coding: [{ system: 'http://hl7.org/fhir/us/davinci-crd/CodeSystem/temp', code: 'coverage-information' }] },
        for: { reference: `Patient/${patient?.id || 'unknown'}` },
        authoredOn: new Date().toISOString(),
        extension: [
          { url: 'http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information#covered', valueCode: 'covered' },
          { url: 'http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information#pa-needed', valueCode: 'auth-needed' },
          { url: 'http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information#billingCode', valueCoding: { system: 'http://www.ama-assn.org/go/cpt', code: orderedCode || '' } },
          { url: 'http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information#date', valueDateTime: new Date().toISOString() }
        ]
      }
    };

    logTransaction('PAS Gateway', 'COVERAGE-INFORMATION ACTION (DENIAL)',
      JSON.stringify(deniedAction.resource, null, 2),
      { patientId: patient?.id || 'unknown' }
    );
    logTransaction('PAS Translator', 'FHIR RESPONSE (DENIAL)',
      `ClaimResponse: outcome=complete, reviewAction A3 Not Certified, reason ${reason.code} ${reason.display} (X12 886). Appeal period: 60 days.`,
      { patientId: patient?.id || 'unknown', clock, decidedAt: new Date().toISOString() }
    );

    // Response is a PAS response Bundle: the ClaimResponse plus the
    // coverage-information Task carried as a second entry.
    return NextResponse.json(
      wrapPasResponseBundle([deniedClaimResponse, deniedAction.resource])
    );
  }

  // Blepharoplasty (15820) always pends — functional impairment review required.
  if (orderedCode === '15820') {
    const authNumber = `AUTH${Date.now().toString().slice(-7)}`;

    const pendedClaimResponse = {
      resourceType: 'ClaimResponse',
      id: `cr-${Date.now()}`,
      meta: { profile: [PAS_PROFILES.claimResponse] },
      status: 'active',
      type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'institutional' }] },
      use: 'preauthorization',
      patient: { reference: `Patient/${patient?.id || 'unknown'}` },
      created: new Date().toISOString(),
      // PAS binds outcome to complete | error | partial. A pend is a
      // completed adjudication whose review action is A4.
      outcome: 'complete',
      disposition: `Prior authorization request is pending clinical review for functional impairment determination. ${
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
      claimItems: (claim?.item || []).map((it) => ({ sequence: it.sequence })),
      clock,
      decideAfter: Date.now() + reviewWindow(),
    });

    logTransaction('PAS Gateway', 'PA PENDED',
      `Auth # ${authNumber} — routed to ${vendor} clinical review queue. rest-hook notification (R4 Subscriptions Backport) will fire on determination.\n\n${JSON.stringify(pendedClaimResponse, null, 2)}`,
      { patientId: patient?.id || 'unknown', clock }
    );

    return NextResponse.json(wrapPasResponseBundle([pendedClaimResponse]));
  }

  // ---- Standard synchronous path (all other codes) -------------------------

  // Simulate mainframe latency.
  await new Promise((r) => setTimeout(r, 2500));

  const authNumber = `AUTH${Date.now().toString().slice(-7)}`;
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
    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'institutional' }] },
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
    resource: {
      resourceType: 'Task',
      status: 'completed',
      intent: 'proposal',
      code: { coding: [{ system: 'http://hl7.org/fhir/us/davinci-crd/CodeSystem/temp', code: 'coverage-information' }] },
      for: { reference: `Patient/${patient?.id || 'unknown'}` },
      authoredOn: new Date().toISOString(),
      extension: [
        { url: 'http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information#covered', valueCode: 'covered' },
        { url: 'http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information#pa-needed', valueCode: 'satisfied' },
        { url: 'http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information#billingCode', valueCoding: { system: 'http://www.ama-assn.org/go/cpt', code: orderedCode || '' } },
        { url: 'http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information#date', valueDateTime: new Date().toISOString() },
        { url: 'http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information#satisfied-pa-id', valueString: authNumber }
      ]
    }
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
    { patientId: patient?.id || 'unknown', clock, decidedAt: new Date().toISOString() }
  );

  return NextResponse.json(
    wrapPasResponseBundle([claimResponse, satisfiedAction.resource])
  );
}
