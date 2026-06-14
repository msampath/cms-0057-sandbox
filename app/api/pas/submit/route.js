import { NextResponse } from 'next/server';
import { getDb, logTransaction, addPendingRequest, finalizePendingRequest } from '@/lib/db';
import { resolveRouting } from '@/lib/routing';
import {
  generateX12_278,
  generateX12_278_Response,
  getReceiverId
} from '../x12Generator';

/**
 * PAS submit endpoint.
 *
 * Accepts a FHIR `Bundle` (type=transaction). The Bundle is preserved
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
  if (planType === 'COMM-PPO' || planType === 'COMM-HMO') return !isMa;
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
  const planType = bundle.planType || null;

  logTransaction(
    'PAS Gateway',
    'BUNDLE RECEIVED',
    `FHIR Bundle (type=${bundle.type || '—'}) for Patient/${patient?.id || 'unknown'}, code=${orderedCode || '—'}. Bundle preserved unaltered.`
  );

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

  // Denial simulation — triggered by _simulateDenial flag from EHR debug toggle.
  if (bundle._simulateDenial) {
    const authNumber = `DENY${Date.now().toString().slice(-7)}`;
    const receiverId = getReceiverId(vendor);

    const x12Denial = [
      `ISA*00*          *00*          *ZZ*${receiverId.padEnd(15)}*ZZ*PROVIDER001    *${new Date().toISOString().slice(2, 10).replace(/-/g, '')}*1200*^*00501*000000003*0*T*:`,
      `GS*HI*${receiverId}*PROVIDER001*${new Date().toISOString().slice(0, 10).replace(/-/g, '')}*1200*3*X*005010X217`,
      `ST*278*0001*005010X217`,
      `BHT*0007*11*DENY-${Date.now().toString().slice(-8)}*${new Date().toISOString().slice(0, 10).replace(/-/g, '')}*1200*18`,
      `HL*1**20*1`,
      `AAA*N*A4*A1*Y`,
      `HCR*NA`,
      `REF*9F*${authNumber}`,
      `SE*8*0001`,
      `GE*1*3`,
      `IEA*1*000000003`
    ].join('~\n') + '~';

    logTransaction('PAS Gateway', 'X12 278 REQUEST', {
      kind: 'fhir-x12-translation',
      vendor,
      bundle,
      x12,
      mappings,
      note: 'Bundle preserved unaltered; X12 is a parallel projection for the legacy adjudication engine.'
    });
    logTransaction('Legacy UM Mainframe', 'X12 278 RESPONSE (DENIAL)',
      `Decision: DENIED. Reason: AAA*N*A4. Not medically necessary.\n\n${x12Denial}`
    );

    const deniedClaimResponse = {
      resourceType: 'ClaimResponse',
      id: `cr-${Date.now()}`,
      status: 'active',
      type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'institutional' }] },
      use: 'preauthorization',
      patient: { reference: `Patient/${patient?.id || 'unknown'}` },
      outcome: 'error',
      disposition: `Prior Authorization Denied by ${vendor}. Service does not meet clinical criteria for medical necessity.`,
      preAuthRef: authNumber,
      insurer: { display: vendor },
      reviewAction: {
        actionCode: [{ coding: [{ system: 'http://hl7.org/fhir/us/davinci-pas/CodeSystem/PASTempCodes', code: 'deny', display: 'Deny' }] }],
        reasonCode: [{
          coding: [{ system: 'https://x12.org/codes/AAA', code: 'A4', display: 'Not medically necessary' }],
          text: `The requested service (${orderedCode || 'service'}) does not meet ${vendor} clinical criteria for medical necessity. Functional impairment or clinical indication documentation submitted is insufficient under policy MED-0472. Appeal rights apply within 60 days of this determination.`
        }]
      },
      error: [{
        code: {
          coding: [{ system: 'https://x12.org/codes/AAA', code: 'A4', display: 'Not medically necessary' }],
          text: 'Not medically necessary'
        },
        expression: ['Claim.item[0]']
      }]
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
      JSON.stringify(deniedAction.resource, null, 2)
    );
    logTransaction('PAS Translator', 'FHIR RESPONSE (DENIAL)',
      `ClaimResponse: outcome=error, reviewAction.actionCode=deny, X12 AAA A4 — Not medically necessary. Appeal period: 60 days.`
    );

    return NextResponse.json({ ...deniedClaimResponse, systemActions: [deniedAction], _routedTo: vendor });
  }

  // Blepharoplasty (15820) always pends — functional impairment review required.
  if (orderedCode === '15820') {
    const authNumber = `AUTH${Date.now().toString().slice(-7)}`;

    const pendedClaimResponse = {
      resourceType: 'ClaimResponse',
      id: `cr-${Date.now()}`,
      status: 'active',
      type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'institutional' }] },
      use: 'preauthorization',
      patient: { reference: `Patient/${patient?.id || 'unknown'}` },
      outcome: 'queued',
      disposition: 'Prior authorization request is pending clinical review. Standard decision timeline: 7 calendar days.',
      preAuthRef: authNumber,
      insurer: { display: vendor },
      reviewAction: {
        actionCode: [{ coding: [{ system: 'http://hl7.org/fhir/us/davinci-pas/CodeSystem/PASTempCodes', code: 'pend' }] }],
        reasonCode: [{ coding: [{ system: 'http://hl7.org/fhir/us/davinci-pas/CodeSystem/PASTempCodes', code: 'clinical-review-required' }], text: 'Clinical documentation review required for functional impairment determination' }]
      }
    };

    addPendingRequest(authNumber, {
      authNumber,
      vendor,
      patientId: patient?.id,
      orderedCode,
    });

    logTransaction('PAS Gateway', 'PA PENDED',
      `Auth # ${authNumber} — routed to ${vendor} clinical review queue. rest-hook notification (R4 Subscriptions Backport) will fire on determination.\n\n${JSON.stringify(pendedClaimResponse, null, 2)}`
    );

    // Simulate clinical reviewer finalizing after 8 seconds.
    setTimeout(() => {
      const finalAction = {
        type: 'update',
        description: 'Coverage information updated — PA determination finalized after clinical review',
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

      const finalClaimResponse = {
        resourceType: 'ClaimResponse',
        id: `cr-final-${Date.now()}`,
        status: 'active',
        type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'institutional' }] },
        use: 'preauthorization',
        patient: { reference: `Patient/${patient?.id || 'unknown'}` },
        outcome: 'complete',
        disposition: `Prior Authorization Approved by ${vendor}. Functional impairment criteria met on clinical review.`,
        preAuthRef: authNumber,
        insurer: { display: vendor },
        _routedTo: vendor,
        _wasPended: true,
        systemActions: [finalAction]
      };

      finalizePendingRequest(authNumber, {
        claimResponse: finalClaimResponse,
        systemAction: finalAction
      });

      logTransaction('Clinical Review Team', 'PA APPROVED (pended → finalized)',
        `Auth # ${authNumber} — functional impairment criteria met. Determination: APPROVED.`
      );
      logTransaction('PAS Gateway', 'REST-HOOK NOTIFICATION',
        `Subscription notification fired to EHR rest-hook endpoint per R4 Subscriptions Backport IG.\n\n${JSON.stringify(finalClaimResponse, null, 2)}`
      );
    }, 8000);

    return NextResponse.json({ ...pendedClaimResponse, _routedTo: vendor });
  }

  // ---- Standard synchronous path (all other codes) -------------------------

  // Simulate mainframe latency.
  await new Promise((r) => setTimeout(r, 2500));

  const authNumber = `AUTH${Date.now().toString().slice(-7)}`;
  const receiverId = getReceiverId(vendor);
  const x12Response = generateX12_278_Response({ receiverId, authNumber });

  logTransaction(
    'Legacy UM Mainframe',
    'X12 278 RESPONSE',
    `Decision: APPROVED. Auth # ${authNumber}.\n\n${x12Response}`
  );

  // FHIR ClaimResponse is constructed directly from the preserved Bundle
  // + the auth number lifted from the X12 response. No round-trip.
  const claimResponse = {
    resourceType: 'ClaimResponse',
    id: `cr-${Date.now()}`,
    status: 'active',
    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'institutional' }] },
    use: 'preauthorization',
    patient: { reference: `Patient/${patient?.id || 'unknown'}` },
    outcome: 'complete',
    disposition: `Prior Authorization Approved by ${vendor}.`,
    preAuthRef: authNumber,
    insurer: { display: vendor }
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
    JSON.stringify(satisfiedAction.resource, null, 2)
  );
  logTransaction(
    'PAS Translator',
    'FHIR RESPONSE',
    `ClaimResponse synthesised from preserved Bundle + auth # ${authNumber} (no FHIR→X12→FHIR round-trip).`
  );

  return NextResponse.json({
    ...claimResponse,
    systemActions: [satisfiedAction],
    _routedTo: vendor
  });
}
