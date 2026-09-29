/**
 * Illustrative NCPDP messages for the pharmacy-benefit drug track.
 *
 *   RTPB request/response → F&B formulary lookup → SCRIPT ePA:
 *   PAInitiationRequest → PAInitiationResponse (question set)
 *     → PARequest (answers) → PAResponse (determination)
 *
 * Transaction names follow NCPDP SCRIPT 2023011 ePA and RTPB v13. The
 * NCPDP standards are licensed, so element structure is simplified and
 * NCPDP external code list values are not reproduced. These are not
 * certified payloads. Every message says so in its first line.
 */
import { DRUG_CATALOG, DRUG_DENIAL_REASONS } from './drugPa';

const BANNER = '<!-- Illustrative only. Transaction names follow NCPDP SCRIPT 2023011 / RTPB v13. Not a certified NCPDP payload. -->';

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function envelope({ to, from, messageId, body }) {
  return [
    BANNER,
    `<Message version="2023011">`,
    `  <Header>`,
    `    <To>${esc(to)}</To>`,
    `    <From>${esc(from)}</From>`,
    `    <MessageID>${esc(messageId)}</MessageID>`,
    `    <SentTime>${new Date().toISOString()}</SentTime>`,
    `  </Header>`,
    `  <Body>`,
    ...body.map((l) => `    ${l}`),
    `  </Body>`,
    `</Message>`
  ].join('\n');
}

function drugLines(drug, form) {
  return [
    `<MedicationPrescribed>`,
    `  <DrugDescription>${esc(drug.name)}, ${esc(form.label)}</DrugDescription>`,
    `  <ProductCode qualifier="NDC">${form.ndc}</ProductCode>`,
    `  <DrugDBCode qualifier="RxNorm">${form.rxcui}</DrugDBCode>`,
    `</MedicationPrescribed>`
  ];
}

/**
 * Formulary and Benefit (F&B v60) is a file the prescriber system loads,
 * not a transaction. This is the lookup against that file. Values are
 * illustrative.
 */
export function formularyLookup(drugKey) {
  const drug = DRUG_CATALOG[drugKey];
  return {
    ndc: drug.siteOfCare.self.ndc,
    formularyStatus: 'On formulary, specialty tier',
    coverageFactors: ['Prior authorization required', 'Step therapy'],
    source: 'F&B v60 formulary file (illustrative)'
  };
}

export function rtpbRequest({ drugKey, patientId, prescriberNpi, pbm }) {
  const drug = DRUG_CATALOG[drugKey];
  return envelope({
    to: pbm,
    from: prescriberNpi,
    messageId: `RTPB-${Date.now()}`,
    body: [
      `<RTPBRequest>`,
      `  <Patient><Identification><MemberID>${esc(patientId)}</MemberID></Identification></Patient>`,
      ...drugLines(drug, drug.siteOfCare.self).map((l) => `  ${l}`),
      `</RTPBRequest>`
    ]
  });
}

export function rtpbResponse({ drugKey, patientId, pbm, prescriberNpi }) {
  const drug = DRUG_CATALOG[drugKey];
  return envelope({
    to: prescriberNpi,
    from: pbm,
    messageId: `RTPB-R-${Date.now()}`,
    body: [
      `<RTPBResponse>`,
      `  <Patient><Identification><MemberID>${esc(patientId)}</MemberID></Identification></Patient>`,
      ...drugLines(drug, drug.siteOfCare.self).map((l) => `  ${l}`),
      `  <CoverageStatus>Covered with restrictions</CoverageStatus>`,
      `  <PriorAuthorizationRequired>Y</PriorAuthorizationRequired>`,
      `  <PatientPay>Specialty tier cost share (illustrative)</PatientPay>`,
      `</RTPBResponse>`
    ]
  });
}

export function paInitiationRequest({ drugKey, patientId, prescriberNpi, pbm, caseId }) {
  const drug = DRUG_CATALOG[drugKey];
  return envelope({
    to: pbm,
    from: prescriberNpi,
    messageId: `PAI-${caseId}`,
    body: [
      `<PAInitiationRequest>`,
      `  <PAReferenceID>${esc(caseId)}</PAReferenceID>`,
      `  <Patient><Identification><MemberID>${esc(patientId)}</MemberID></Identification></Patient>`,
      ...drugLines(drug, drug.siteOfCare.self).map((l) => `  ${l}`),
      `</PAInitiationRequest>`
    ]
  });
}

export function paInitiationResponse({ drugKey, prescriberNpi, pbm, caseId }) {
  const drug = DRUG_CATALOG[drugKey];
  const questions = drug.questions.flatMap((q) => [
    `    <Question>`,
    `      <QuestionID>${esc(q.linkId)}</QuestionID>`,
    `      <QuestionText>${esc(q.text)}</QuestionText>`,
    `      <QuestionType>${q.type === 'choice' ? 'Select' : 'Boolean'}</QuestionType>`,
    ...(q.options || []).map((o) => `      <Choice code="${esc(o.code)}">${esc(o.display)}</Choice>`),
    `    </Question>`
  ]);
  return envelope({
    to: prescriberNpi,
    from: pbm,
    messageId: `PAIR-${caseId}`,
    body: [
      `<PAInitiationResponse>`,
      `  <PAReferenceID>${esc(caseId)}</PAReferenceID>`,
      `  <QuestionSet>`,
      `    <QuestionSetID>${esc(drug.questionnaireId)}</QuestionSetID>`,
      ...questions,
      `  </QuestionSet>`,
      `</PAInitiationResponse>`
    ]
  });
}

export function paRequest({ drugKey, prescriberNpi, pbm, caseId, answers }) {
  const drug = DRUG_CATALOG[drugKey];
  const lines = drug.questions.flatMap((q) => [
    `    <Answer>`,
    `      <QuestionID>${esc(q.linkId)}</QuestionID>`,
    `      <Value>${esc(answers[q.linkId] === undefined ? '' : answers[q.linkId])}</Value>`,
    `    </Answer>`
  ]);
  return envelope({
    to: pbm,
    from: prescriberNpi,
    messageId: `PAR-${caseId}`,
    body: [`<PARequest>`, `  <PAReferenceID>${esc(caseId)}</PAReferenceID>`, `  <Answers>`, ...lines, `  </Answers>`, `</PARequest>`]
  });
}

export function paResponse({ prescriberNpi, pbm, caseId, decision }) {
  const reason = decision.reasonKey ? DRUG_DENIAL_REASONS[decision.reasonKey] : null;
  const status = decision.determination === 'approved' ? 'Approved' : 'Denied';
  return envelope({
    to: prescriberNpi,
    from: pbm,
    messageId: `PARS-${caseId}`,
    body: [
      `<PAResponse>`,
      `  <PAReferenceID>${esc(caseId)}</PAReferenceID>`,
      `  <Response>`,
      `    <${status}>`,
      ...(status === 'Approved'
        ? [`      <AuthorizationNumber>${esc(caseId)}</AuthorizationNumber>`]
        : [
            `      <DenialReason>`,
            `        <ReasonKey>${esc(decision.reasonKey || 'unspecified')}</ReasonKey>`,
            `        <Text>${esc(reason?.text || 'Prior authorization denied')}</Text>`,
            ...(reason ? [`        <X12ReviewDecisionReason>${reason.x12.code}</X12ReviewDecisionReason>`] : []),
            `      </DenialReason>`
          ]),
      `    </${status}>`,
      `  </Response>`,
      `</PAResponse>`
    ]
  });
}
