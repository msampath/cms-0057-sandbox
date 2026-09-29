import { NextResponse } from 'next/server';
import { logTransaction, getDrugPaRecord, upsertDrugPaRecord } from '@/lib/db';
import { resolvePharmacyRouting } from '@/lib/routing';
import { DRUG_CATALOG, DRUG_DENIAL_REASONS, decideDrugPa } from '@/lib/drugPa';
import { decisionClock } from '@/lib/decisionClock';
import { getPatient } from '@/lib/patients';
import {
  formularyLookup,
  rtpbRequest,
  rtpbResponse,
  paInitiationRequest,
  paInitiationResponse,
  paRequest,
  paResponse
} from '@/lib/ncpdpGenerator';

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
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const { step, drugKey, patientId, prescriberNpi = 'unknown', expedited = false } = body;
  const drug = DRUG_CATALOG[drugKey];
  if (!drug || !patientId || !['benefit', 'submit'].includes(step)) {
    return NextResponse.json(
      { error: 'step (benefit|submit), a known drugKey, and patientId are required' },
      { status: 400 }
    );
  }

  const { pbm } = resolvePharmacyRouting();

  // Same order as the PAS route: the plan the EHR is ordering under, then
  // the member's own plan.
  const member = getPatient(patientId);
  const planType = body.planType || member?.planType || null;
  const clock = decisionClock({ planType, isDrug: true, benefit: 'pharmacy', expedited, receivedAt: body.receivedAt });
  // Illustrative FFE issuer exception from the NCPDP requirement. It does
  // not change the decision clock.
  const exception = member?.ncpdpException
    ? { ...member.ncpdpException, applied: !!body.applyException }
    : null;
  const meta = { patientId, npi: prescriberNpi };

  if (step === 'benefit') {
    const caseId = `EPA${Date.now().toString().slice(-7)}`;
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
  const caseId = body.caseId || `EPA${Date.now().toString().slice(-7)}`;
  const answers = body.answers || {};
  const decision = decideDrugPa(drugKey, answers);
  const reason = decision.reasonKey ? DRUG_DENIAL_REASONS[decision.reasonKey] : null;
  const args = { drugKey, prescriberNpi, pbm, caseId, answers, decision };
  const messages = [
    { name: 'PARequest', xml: paRequest(args) },
    { name: 'PAResponse', xml: paResponse(args) }
  ];
  const record = upsertDrugPaRecord(patientId, drugKey, {
    answers,
    decision,
    track: 'pharmacy',
    trackData: { ndc: drug.siteOfCare.self.ndc, pbm, caseId, determination: decision.determination }
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
    { ...meta, clock, decidedAt: new Date().toISOString() }
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
