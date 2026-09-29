import { NextResponse } from 'next/server';
import { getDb, logTransaction, getDrugPaRecord, upsertDrugPaRecord, nextRequestId, openEpaCase, getEpaCase } from '@/lib/db';
import { resolvePharmacyRouting } from '@/lib/routing';
import { DRUG_CATALOG, DRUG_DENIAL_REASONS, decideDrugPa, sanitizeDrugAnswers } from '@/lib/drugPa';
import { decisionClock } from '@/lib/decisionClock';
import { getPatient, PATIENT_LIST } from '@/lib/patients';
import {
  formularyLookup,
  rtpbRequest,
  rtpbResponse,
  paInitiationRequest,
  paInitiationResponse,
  paRequest,
  paResponse
} from '@/lib/ncpdpGenerator';
import { withUsage } from '@/lib/withUsage';

/**
 * Pharmacy-benefit drug track (NCPDP), routed to the PBM.
 *
 *   step 'benefit' → RTPB request/response, F&B formulary lookup,
 *                    PAInitiationRequest → PAInitiationResponse (question set).
 *                    Returns any answers already on the shared record so the
 *                    prescriber is not re-asked.
 *   step 'submit'  → PARequest (answers) → PAResponse, decided by the same
 *                    decideDrugPa() the PAS (medical) track uses.
 *
 * Structured NCPDP payloads are logged without patient meta, like the X12
 * 278 request, so the access APIs only see the plain-text determination.
 */
async function handlePOST(request) {
  const body = await request.json().catch(() => ({}));
  const { step, drugKey, patientId } = body;
  const prescriberNpi = body.prescriberNpi ?? null;
  const expedited = body.expedited === true;
  // The clock starts when the benefit step opens the case. A submit
  // reuses that start, whatever the client sends.
  // A case is reused only by the same patient and drug that opened it.
  const opened = getEpaCase(body.caseId);
  const knownCase = !!opened && opened.patientId === patientId && opened.drugKey === drugKey;
  const receivedAt = step === 'submit' && knownCase ? opened.receivedAt : new Date().toISOString();
  const ID = /^[A-Za-z0-9._-]{1,64}$/;
  const drug = typeof drugKey === 'string' && Object.hasOwn(DRUG_CATALOG, drugKey) ? DRUG_CATALOG[drugKey] : null;
  if (!drug || typeof patientId !== 'string' || !ID.test(patientId) || !['benefit', 'submit'].includes(step)) {
    return NextResponse.json(
      { error: 'step (benefit|submit), a known drugKey, and patientId are required' },
      { status: 400 }
    );
  }
  if (prescriberNpi !== null && (typeof prescriberNpi !== 'string' || !ID.test(prescriberNpi))) {
    return NextResponse.json({ error: 'prescriberNpi must be an identifier string' }, { status: 400 });
  }
  // Configured plans plus the member plans with a clock (Medicaid, QHP).
  const plans = [...new Set([...(getDb().plans || []).map((p) => p.plan_type), ...PATIENT_LIST.map((p) => p.planType)])];
  if (body.planType != null && !plans.includes(body.planType)) {
    return NextResponse.json({ error: `planType must be one of ${plans.join(', ')}` }, { status: 400 });
  }
  if (body.answers != null && (typeof body.answers !== 'object' || Array.isArray(body.answers))) {
    return NextResponse.json({ error: 'answers must be an object' }, { status: 400 });
  }
  // The case id becomes part of a FHIR id, so only FHIR id characters.
  if (body.caseId != null && (typeof body.caseId !== 'string' || !/^[A-Za-z0-9.-]{1,32}$/.test(body.caseId))) {
    return NextResponse.json({ error: 'caseId must be an identifier string' }, { status: 400 });
  }

  const { pbm } = resolvePharmacyRouting();

  // Same order as the PAS route: the plan the EHR is ordering under, then
  // the member's own plan.
  const member = getPatient(patientId);
  const planType = body.planType || member?.planType || null;
  const clock = decisionClock({ planType, isDrug: true, benefit: 'pharmacy', expedited, receivedAt });
  // Illustrative FFE issuer exception from the NCPDP requirement. It does
  // not change the decision clock.
  const exception = member?.ncpdpException
    ? { ...member.ncpdpException, applied: !!body.applyException }
    : null;
  const meta = { patientId, npi: prescriberNpi };

  if (step === 'benefit') {
    const caseId = nextRequestId('EPA');
    openEpaCase(caseId, { patientId, drugKey, receivedAt });
    const args = { drugKey, patientId, prescriberNpi, pbm, caseId };
    const formulary = formularyLookup(drugKey);
    const messages = [
      { name: 'RTPBRequest', xml: rtpbRequest(args) },
      { name: 'RTPBResponse', xml: rtpbResponse(args) },
      { name: 'PAInitiationRequest', xml: paInitiationRequest(args) },
      { name: 'PAInitiationResponse', xml: paInitiationResponse(args) }
    ];
    logTransaction('Prime Therapeutics', 'NCPDP RTPB + ePA INITIATION', {
      kind: 'ncpdp',
      pbm,
      messages,
      note: `Pharmacy benefit for ${drug.name} (NDC ${drug.siteOfCare.self.ndc}): RTPB says PA required. F&B: ${formulary.formularyStatus}. ePA case ${caseId} opened, question set returned.`
    });
    logTransaction(
      'Prime Therapeutics',
      'NCPDP ePA INITIATED',
      `Pharmacy-benefit PA case ${caseId} for ${drug.name}, routed to ${pbm}.`,
      meta
    );
    const record = getDrugPaRecord(patientId, drugKey);
    return NextResponse.json({
      pbm,
      caseId,
      planType,
      clock,
      exception,
      formulary,
      rtpb: { coverageStatus: 'Covered with restrictions', priorAuthorizationRequired: true },
      questions: drug.questions,
      prefill: record?.answers || null,
      prefillFrom: record?.tracks?.medical ? 'medical' : null,
      messages
    });
  }

  // step === 'submit'
  // Only a case this server opened is reused, so a client cannot overwrite
  // another request's metrics row.
  const caseId = knownCase ? body.caseId : nextRequestId('EPA');
  const answers = sanitizeDrugAnswers(drugKey, body.answers);
  // Like a PAS Bundle with no QuestionnaireResponse, an empty answer set
  // is not a decision by the shared model: it does not change the shared
  // record's determination, and the metrics and access APIs leave it out.
  const noAnswers = Object.keys(answers).length === 0;
  const decision = decideDrugPa(drugKey, answers);
  const reason = decision.reasonKey ? DRUG_DENIAL_REASONS[decision.reasonKey] : null;
  const args = { drugKey, prescriberNpi, pbm, caseId, answers, decision };
  const messages = [
    { name: 'PARequest', xml: paRequest(args) },
    { name: 'PAResponse', xml: paResponse(args) }
  ];
  const record = upsertDrugPaRecord(patientId, drugKey, {
    answers,
    ...(noAnswers ? {} : { decision }),
    track: 'pharmacy',
    trackData: {
      ndc: drug.siteOfCare.self.ndc,
      npi: prescriberNpi,
      pbm,
      caseId,
      determination: decision.determination,
      reasonKey: decision.reasonKey,
      ...(noAnswers ? { noAnswers: true } : {})
    }
  });

  logTransaction('Prime Therapeutics', `NCPDP PA RESPONSE (${decision.determination.toUpperCase()})`, {
    kind: 'ncpdp',
    pbm,
    messages,
    note: `ePA case ${caseId}: ${decision.determination}${reason ? `. ${reason.text} (X12 886 ${reason.x12.code})` : ''}.`
  });
  logTransaction(
    'Prime Therapeutics',
    decision.determination === 'approved' ? 'DRUG PA APPROVED' : 'DRUG PA DENIED',
    `${drug.name}, pharmacy benefit, ePA case ${caseId}${reason ? `. Reason: ${reason.text}` : ''}.`,
    {
      ...meta,
      clock,
      decidedAt: new Date().toISOString(),
      pa: {
        requestId: caseId,
        category: 'drug',
        benefit: 'pharmacy',
        determination: decision.determination,
        planType,
        noAnswers,
        // The benefit step's time for a case this server opened, else now.
        receivedAt: clock.receivedAt || receivedAt,
        decidedAt: new Date().toISOString()
      }
    }
  );

  return NextResponse.json({
    pbm,
    caseId,
    planType,
    clock,
    decidedAt: new Date().toISOString(),
    exception,
    decision,
    reason: reason ? { key: decision.reasonKey, text: reason.text, x12: reason.x12 } : null,
    record,
    messages
  });
}

// Usage metrics (CMS-0062-P): one event per call, bucketed by outcome.
export const POST = withUsage('Pharmacy ePA (NCPDP)', handlePOST);
