/**
 * API regression checks against a running server.
 *
 *   npm run regression                      (defaults to http://localhost:3000/cms-0057)
 *   BASE_URL=https://surakshith.com/cms-0057 npm run regression
 *
 * Covers the four CMS-0057-F APIs plus the CMS-0062-P additions. Each
 * phase adds its checks here. Exits non-zero on the first failed run so it
 * can gate a commit. No test framework: plain fetch and a small check().
 */

const BASE = (process.env.BASE_URL || 'http://localhost:3000/cms-0057').replace(/\/$/, '');
const REVIEW_ACTION = 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/extension-reviewAction';

let failures = 0;
let passes = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passes++;
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

async function call(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

const post = (path, body, headers = {}) =>
  call(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

async function token(scopes) {
  const res = await fetch(`${BASE}/api/auth/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'regression', scope: scopes.join(' ') })
  });
  return (await res.json()).access_token;
}

function review(cr) {
  const adj = [...(cr?.item || []), ...(cr?.addItem || [])].flatMap((i) => i.adjudication || []);
  for (const a of adj) {
    const ext = (a.extension || []).find((e) => e.url === REVIEW_ACTION);
    if (!ext) continue;
    const sub = (u) => ext.extension.find((e) => e.url.endsWith(u));
    return {
      action: sub('extension-reviewActionCode')?.valueCodeableConcept?.coding?.[0]?.code,
      reason: sub('reasonCode')?.valueCodeableConcept?.coding?.[0]?.code
    };
  }
  return null;
}

function pasBundle(code, extra = {}, planType = 'COMM-PPO') {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    planType,
    ...extra,
    entry: [
      { resource: { resourceType: 'Patient', id: 'pat-8849-jane-doe' } },
      { resource: { resourceType: 'Claim', item: [{ sequence: 1, productOrService: { coding: [{ code }] } }] } }
    ]
  };
}

async function logsFor(pattern) {
  const { json } = await call('/api/logs');
  const arr = Array.isArray(json) ? json : json?.logs || json?.entries || [];
  return arr.filter((l) => pattern.test(l.action));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

async function baseline() {
  console.log('\nDiscovery');
  const meta = await call('/api/fhir/metadata');
  check('CapabilityStatement', meta.status === 200 && meta.json?.resourceType === 'CapabilityStatement');
  const cds = await call('/api/cds-services');
  check('CDS Hooks discovery', cds.status === 200 && Array.isArray(cds.json?.services));

  console.log('\nCRD order-sign');
  const hook = await post('/api/cds-services/order-sign', {
    hook: 'order-sign', hookInstance: 'reg-1', code: '70553', planType: 'COMM-PPO',
    practitionerNpi: '1234567890', patientId: 'pat-8849-jane-doe', patient: { id: 'pat-8849-jane-doe' }
  });
  check('card returned for 70553', hook.status === 200 && hook.json?.cards?.length > 0);

  console.log('\nPAS determinations (Phase 0)');
  const ok = (await post('/api/pas/submit', pasBundle('70553'))).json?.entry?.[0]?.resource;
  check('approval: outcome complete + A1', ok?.outcome === 'complete' && review(ok)?.action === 'A1', JSON.stringify(review(ok)));
  check('approval: created present', !!ok?.created);
  const deny = (await post('/api/pas/submit', pasBundle('70553', { _simulateDenial: true }))).json?.entry?.[0]?.resource;
  check('denial: outcome complete + A3 + 0F', deny?.outcome === 'complete' && review(deny)?.action === 'A3' && review(deny)?.reason === '0F', JSON.stringify(review(deny)));
  check('denial: no error[]', !deny?.error);
  const pend = (await post('/api/pas/submit', pasBundle('15820', {}, 'MA-PPO'))).json?.entry?.[0]?.resource;
  check('pend: outcome complete + A4', pend?.outcome === 'complete' && review(pend)?.action === 'A4', JSON.stringify(review(pend)));
  const bad = (await post('/api/pas/submit', { resourceType: 'Bundle', type: 'collection', entry: [] })).json?.entry?.[0]?.resource;
  check('validation error: outcome error + 901 code 15', bad?.outcome === 'error' && bad?.error?.[0]?.code?.coding?.[0]?.code === '15');

  console.log('\nX12 278 responses');
  const approvals = await logsFor(/^X12 278 RESPONSE$/);
  const a = String(approvals[0]?.details || '');
  check('approval 278 has HCR*A1, no AAA', a.includes('HCR*A1*') && !a.includes('AAA*'));
  const denials = await logsFor(/X12 278 RESPONSE \(DENIAL\)/);
  check('denial 278 has HCR*A3**0F', String(denials[0]?.details || '').includes('HCR*A3**0F'));
  const errors = await logsFor(/VALIDATION ERROR/);
  check('validation 278 has AAA*N**15*C', String(errors[0]?.details || '').includes('AAA*N**15*C'));

  console.log('\nPended finalization (request-driven, ~8s window)');
  // Since Phase 6 a pend waits for the CDex attachment it requested.
  await post('/api/cdex/$submit-attachment', {
    resourceType: 'Parameters',
    parameter: [
      { name: 'TrackingId', valueIdentifier: { value: pend?.preAuthRef } },
      { name: 'AttachTo', valueCode: 'preauthorization' },
      { name: 'ProviderId', valueIdentifier: { value: '1234567890' } },
      { name: 'MemberId', valueIdentifier: { value: 'BCBSIL-MEM-849' } },
      { name: 'Attachment', part: [{ name: 'Content', resource: { resourceType: 'DocumentReference', status: 'current', content: [{ attachment: { data: 'dGVzdA==' } }] } }] }
    ]
  });
  await sleep(8500);
  const fin = await call(`/api/pas/pended/${pend?.preAuthRef}`);
  const finCr = fin.json?.responseBundle?.entry?.[0]?.resource;
  check('pended request finalizes to A1 after its attachment', fin.status === 200 && review(finCr)?.action === 'A1', fin.json?.status);

  console.log('\nSMART auth and access APIs');
  const noTok = await call('/api/patient-access?patientId=pat-8849-jane-doe');
  check('Patient Access without token → 401', noTok.status === 401);
  const pTok = await token(['patient/Patient.read', 'patient/Coverage.read', 'patient/ExplanationOfBenefit.read', 'patient/ClaimResponse.read']);
  const pa = await call('/api/patient-access?patientId=pat-8849-jane-doe', { headers: { authorization: `Bearer ${pTok}` } });
  check('Patient Access with token → 200 + Patient', pa.status === 200 && pa.json?.patient?.resourceType === 'Patient');
  const sTok = await token(['system/Patient.read', 'system/ExplanationOfBenefit.read', 'system/ClaimResponse.read', 'system/Coverage.read']);
  const prov = await call('/api/provider-access?npi=1234567890', { headers: { authorization: `Bearer ${sTok}` } });
  check('Provider Access with token → 200', prov.status === 200);

  console.log('\nPayer-to-Payer');
  const mm = await post('/api/payer-to-payer/member-match', {
    resourceType: 'Parameters',
    parameter: [
      { name: 'MemberPatient', resource: { resourceType: 'Patient', id: 'pat-8849-jane-doe' } },
      { name: 'CoverageToMatch', resource: { resourceType: 'Coverage', subscriberId: 'BCBSIL-MEM-849' } }
    ]
  }, { authorization: `Bearer ${sTok}` });
  const memberId = mm.json?.parameter?.find((p) => p.name === 'MemberIdentifier')?.valueIdentifier?.value;
  check('$member-match returns MemberIdentifier', mm.status === 200 && !!memberId);
  const hist = await call(`/api/payer-to-payer/history/${memberId}`, { headers: { authorization: `Bearer ${sTok}` } });
  const crs = (hist.json?.entry || []).map((e) => e.resource).filter((r) => r.resourceType === 'ClaimResponse');
  const denied = crs.find((cr) => review(cr)?.action === 'A3');
  check('history has an A3 denial with 886 code 44', denied && review(denied)?.reason === '44');
  check('history ClaimResponses have no error[]', crs.every((cr) => !cr.error));
}

async function phase1() {
  console.log('\nPhase 1: versioned canonicals');
  const meta = (await call('/api/fhir/metadata')).json;
  const igs = meta?.implementationGuide || [];
  check('PAS IG pinned to 2.2.1', igs.includes('http://hl7.org/fhir/us/davinci-pas/ImplementationGuide/hl7.fhir.us.davinci-pas|2.2.1'));
  check('CRD IG pinned to 2.2.1', igs.some((u) => u.endsWith('hl7.fhir.us.davinci-crd|2.2.1')));
  check('CARIN BB IG pinned to 2.2.0', igs.some((u) => u.endsWith('hl7.fhir.us.carin-bb|2.2.0')));
  check('DTR IG listed without a version', igs.some((u) => u.endsWith('hl7.fhir.us.davinci-dtr')));
  check('CDex not claimed', !igs.some((u) => u.includes('davinci-cdex')));
  const res = (type) => meta?.rest?.[0]?.resource?.find((r) => r.type === type)?.profile;
  check('Claim profile pinned to PAS 2.2.1', res('Claim')?.endsWith('profile-claim|2.2.1'), res('Claim'));
  check('ClaimResponse profile pinned to PAS 2.2.1', res('ClaimResponse')?.endsWith('profile-claimresponse|2.2.1'), res('ClaimResponse'));
  check('Coverage profile pinned to CARIN BB 2.2.0', res('Coverage')?.endsWith('C4BB-Coverage|2.2.0'), res('Coverage'));
  check('EOB profile pinned to CARIN BB 2.2.0', res('ExplanationOfBenefit')?.endsWith('|2.2.0'), res('ExplanationOfBenefit'));
  check('Patient profile pinned to US Core 6.1.0 (Phase 7)', res('Patient') === 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient|6.1.0', res('Patient'));
  check('US Core IG pinned to 6.1.0, 3.1.1 not advertised', igs.includes('http://hl7.org/fhir/us/core/ImplementationGuide/hl7.fhir.us.core|6.1.0') && !igs.some((u) => u.endsWith('|3.1.1')));
  check('PDex IG pinned to 2.0.0', igs.some((u) => u.endsWith('hl7.fhir.us.davinci-pdex|2.0.0')));
}

function drugPasBundle(patientId, answers) {
  const qrItem = (linkId, a) =>
    a === undefined ? { linkId } : { linkId, answer: [typeof a === 'boolean' ? { valueBoolean: a } : { valueCoding: { code: a } }] };
  return {
    resourceType: 'Bundle',
    type: 'collection',
    planType: 'COMM-PPO',
    entry: [
      { resource: { resourceType: 'Patient', id: patientId } },
      { resource: { resourceType: 'Claim', item: [{ sequence: 1, productOrService: { coding: [{ code: 'J0717' }] } }] } },
      {
        resource: {
          resourceType: 'QuestionnaireResponse',
          status: 'completed',
          item: Object.entries(answers).map(([k, v]) => qrItem(k, v))
        }
      }
    ]
  };
}

async function phase2() {
  console.log('\nPhase 2: one drug, two benefits');
  const hook = await post('/api/cds-services/order-sign', {
    hook: 'order-sign', hookInstance: 'reg-2', code: 'J0717', planType: 'COMM-PPO',
    practitionerNpi: '1234567890', patientId: 'pat-8849-jane-doe', patient: { id: 'pat-8849-jane-doe' }
  });
  const ctx = JSON.parse(hook.json?.cards?.[0]?.links?.[0]?.appContext || '{}');
  check('CRD binds J0717 (real grid rule) to the drug questionnaire', ctx.questionnaireId === 'drug-certolizumab', ctx.questionnaireId);
  const q = (await call('/api/questionnaire/drug-certolizumab')).json;
  check('drug questionnaire generated from shared model (3 items)', q?.item?.length === 3);

  // Denied: medical first, then pharmacy with the carried-over answers.
  const pid = `pat-reg-${Date.now()}`;
  const deny = { diagnosis: 'M05.79', 'conventional-therapy-failed': false, 'tb-screen-negative': true };
  const med = (await post('/api/pas/submit', drugPasBundle(pid, deny))).json?.entry?.[0]?.resource;
  check('medical track: step therapy not met → A3 + 886 code 44', review(med)?.action === 'A3' && review(med)?.reason === '44', JSON.stringify(review(med)));
  const ben = (await post('/api/drug-pa/pharmacy', { step: 'benefit', drugKey: 'certolizumab', patientId: pid, prescriberNpi: '1234567890' })).json;
  check('pharmacy track routed to Prime Therapeutics', ben?.pbm === 'Prime Therapeutics');
  check('RTPB says PA required', ben?.rtpb?.priorAuthorizationRequired === true);
  check('answers carried over from medical track', ben?.prefillFrom === 'medical' && JSON.stringify(ben?.prefill) === JSON.stringify(deny), JSON.stringify(ben?.prefill));
  check('PAInitiationResponse carries the same 3 questions', (ben?.messages?.find((m) => m.name === 'PAInitiationResponse')?.xml.match(/<Question>/g) || []).length === 3);
  const sub = (await post('/api/drug-pa/pharmacy', { step: 'submit', drugKey: 'certolizumab', patientId: pid, prescriberNpi: '1234567890', caseId: ben?.caseId, answers: ben?.prefill })).json;
  check('pharmacy track: same denial, same reason key and 886 code', sub?.decision?.determination === 'denied' && sub?.reason?.key === 'step-therapy' && sub?.reason?.x12?.code === '44');
  check('PAResponse XML carries X12 886 code 44', sub?.messages?.find((m) => m.name === 'PAResponse')?.xml.includes('<X12ReviewDecisionReason>44<'));
  const rec = (await call(`/api/drug-pa/record?patientId=${pid}&drugKey=certolizumab`)).json?.record;
  check('one shared record with both tracks, both denied', rec?.determination === 'denied' && rec?.tracks?.medical?.determination === 'denied' && rec?.tracks?.pharmacy?.determination === 'denied');

  // Approved: pharmacy first, then medical from the record's answers.
  const pid2 = `pat-reg-${Date.now()}-b`;
  const ok = { diagnosis: 'K50.90', 'conventional-therapy-failed': true, 'tb-screen-negative': true };
  const b2 = (await post('/api/drug-pa/pharmacy', { step: 'benefit', drugKey: 'certolizumab', patientId: pid2 })).json;
  check('no prefill before either track has run', b2?.prefill === null);
  const s2 = (await post('/api/drug-pa/pharmacy', { step: 'submit', drugKey: 'certolizumab', patientId: pid2, caseId: b2?.caseId, answers: ok })).json;
  check('pharmacy track approves when criteria met', s2?.decision?.determination === 'approved' && !s2?.reason);
  const med2 = (await post('/api/pas/submit', drugPasBundle(pid2, s2?.record?.answers || {}))).json?.entry?.[0]?.resource;
  check('medical track approves from the same answers → A1', review(med2)?.action === 'A1');
  const rec2 = (await call(`/api/drug-pa/record?patientId=${pid2}&drugKey=certolizumab`)).json?.record;
  check('shared record approved on both tracks', rec2?.tracks?.medical?.determination === 'approved' && rec2?.tracks?.pharmacy?.determination === 'approved');

  // A debug denial of a request the model approves is recorded as forced
  // and leaves the shared determination and answers alone.
  const forcedBundle = { ...drugPasBundle(pid2, ok), _simulateDenial: true };
  const forced = (await post('/api/pas/submit', forcedBundle)).json?.entry?.[0]?.resource;
  const rec3 = (await call(`/api/drug-pa/record?patientId=${pid2}&drugKey=certolizumab`)).json?.record;
  check('debug denial returns A3 but is marked forced on the record', review(forced)?.action === 'A3' && rec3?.tracks?.medical?.debugForced === true && rec3?.determination === 'approved');
  // A PAS Bundle with no QuestionnaireResponse must not wipe the answers.
  const noQr = drugPasBundle(pid2, {});
  noQr.entry = noQr.entry.filter((e) => e.resource.resourceType !== 'QuestionnaireResponse');
  await post('/api/pas/submit', noQr);
  const rec4 = (await call(`/api/drug-pa/record?patientId=${pid2}&drugKey=certolizumab`)).json?.record;
  check('empty answer set does not wipe stored answers', JSON.stringify(rec4?.answers) === JSON.stringify(ok), JSON.stringify(rec4?.answers));
  check('empty answer set does not flip the shared determination', rec4?.determination === 'approved' && rec4?.tracks?.medical?.noAnswers === true, rec4?.determination);

  // Second denial branch: TB screening missing → 886 code 0U on both tracks.
  const pid3 = `pat-reg-${Date.now()}-c`;
  const tb = { diagnosis: 'M05.79', 'conventional-therapy-failed': true, 'tb-screen-negative': false };
  const medTb = (await post('/api/pas/submit', drugPasBundle(pid3, tb))).json?.entry?.[0]?.resource;
  check('medical track: TB screen missing → A3 + 886 code 0U', review(medTb)?.action === 'A3' && review(medTb)?.reason === '0U', JSON.stringify(review(medTb)));
  const phTb = (await post('/api/drug-pa/pharmacy', { step: 'submit', drugKey: 'certolizumab', patientId: pid3, answers: tb })).json;
  check('pharmacy track: same tb-screen reason and 0U in PAResponse', phTb?.reason?.key === 'tb-screen' && phTb?.messages?.find((m) => m.name === 'PAResponse')?.xml.includes('<X12ReviewDecisionReason>0U<'));

  const bad = await post('/api/drug-pa/pharmacy', { step: 'submit', drugKey: 'nope', patientId: pid });
  check('pharmacy route rejects unknown drug with 400', bad.status === 400);
  const ncpdp = await logsFor(/^NCPDP PA RESPONSE/);
  check('feed has structured NCPDP entries', ncpdp.length > 0 && ncpdp[0].details?.kind === 'ncpdp');
}

async function phase3() {
  console.log('\nPhase 3: decision clocks');
  const hoursBetween = (c) => (Date.parse(c.dueAt) - Date.parse(c.receivedAt)) / 3600000;
  const bene = async (patientId, extra = {}) =>
    (await post('/api/drug-pa/pharmacy', { step: 'benefit', drugKey: 'certolizumab', patientId, ...extra })).json;

  const maria = await bene('pat-5520-maria-santos');
  check('Medicaid drug: 24h single clock', maria?.clock?.hours === 24 && hoursBetween(maria.clock) === 24);
  check('Medicaid drug: 72h emergency supply flag', /72-hour emergency supply/.test(maria?.clock?.emergencySupply || ''));
  check('Medicaid drug: basis cites SSA 1927(d)(5)(A)', /1927\(d\)\(5\)\(A\)/.test(maria?.clock?.basis || ''));
  const mariaX = await bene('pat-5520-maria-santos', { expedited: true });
  check('Medicaid drug: expedited is still 24h', mariaX?.clock?.hours === 24);

  const david = await bene('pat-4410-david-kim');
  check('FFE QHP drug: 72h standard, marked proposed', david?.clock?.hours === 72 && david?.clock?.proposed === true && hoursBetween(david.clock) === 72);
  const davidX = await bene('pat-4410-david-kim', { expedited: true });
  check('FFE QHP drug: 24h expedited', davidX?.clock?.hours === 24);
  check('FFE QHP: issuer NCPDP exception carries an end date', david?.exception?.until === '2028-06-30');
  const davidSub = (await post('/api/drug-pa/pharmacy', {
    step: 'submit', drugKey: 'certolizumab', patientId: 'pat-4410-david-kim', applyException: true,
    receivedAt: david?.clock?.receivedAt, caseId: david?.caseId,
    answers: { diagnosis: 'K50.90', 'conventional-therapy-failed': true, 'tb-screen-negative': true }
  })).json;
  check('FFE QHP: exception does not change the clock', !!david?.clock?.dueAt && davidSub?.clock?.dueAt === david.clock.dueAt && davidSub?.exception?.applied === true);

  const robert = await bene('pat-7712-robert-chen');
  check('MA pharmacy drug: Part D basis (423.568)', /423\.568/.test(robert?.clock?.basis || '') && robert?.clock?.hours === 72);

  const jane = await bene('pat-8849-jane-doe');
  check('Commercial: no federal clock', jane?.clock?.applies === false && /not an impacted payer/.test(jane?.clock?.note || ''));

  // PAS: MA non-drug pend (15820) → 7 days standard, 72h expedited.
  await post('/api/pas/submit', pasBundle('15820', {}, 'MA-PPO'));
  const pend = (await logsFor(/^PA PENDED$/))[0];
  check('MA item pend: 7 calendar days standard', pend?.clock?.hours === 168 && /422\.568/.test(pend?.clock?.basis || ''));
  const statBundle = pasBundle('15820', {}, 'MA-PPO');
  statBundle.entry[1].resource.priority = { coding: [{ code: 'stat' }] };
  const statCr = (await post('/api/pas/submit', statBundle)).json?.entry?.[0]?.resource;
  const pendX = (await logsFor(/^PA PENDED$/))[0];
  check('MA item pend, expedited: 72h', pendX?.clock?.hours === 72 && pendX?.clock?.kind === 'expedited');
  check('pend disposition states the clock, not a fixed 7 days', /Decision due within 72 hours/.test(statCr?.disposition || ''), statCr?.disposition);

  // PAS: QHP medical-benefit drug approval → proposed 72h clock on the decision log.
  const qhp = drugPasBundle('pat-4410-david-kim', { diagnosis: 'K50.90', 'conventional-therapy-failed': true, 'tb-screen-negative': true });
  qhp.planType = 'QHP-FFE';
  const qhpCr = (await post('/api/pas/submit', qhp)).json?.entry?.[0]?.resource;
  const qhpLog = (await logsFor(/^FHIR RESPONSE$/))[0];
  check('QHP medical drug: J0717 matches commercial grid → A1', review(qhpCr)?.action === 'A1');
  check('QHP medical drug: decision log carries proposed 72h clock + decidedAt', qhpLog?.clock?.hours === 72 && qhpLog?.clock?.proposed && !!qhpLog?.decidedAt);

  // A conformant Bundle with no sandbox planType falls back to the member's plan.
  const bare = drugPasBundle('pat-4410-david-kim', { diagnosis: 'K50.90', 'conventional-therapy-failed': true, 'tb-screen-negative': true });
  delete bare.planType;
  const bareCr = (await post('/api/pas/submit', bare)).json?.entry?.[0]?.resource;
  check('PAS without planType: approved (A1)', review(bareCr)?.action === 'A1', JSON.stringify(review(bareCr)));
  const bareLog = (await logsFor(/^FHIR RESPONSE$/))[0];
  check('PAS without planType uses the member plan (QHP clock)', bareLog?.clock?.hours === 72 && bareLog?.clock?.proposed === true);

  // Medicaid has no ingested grid, so J0717 is not on it.
  const medHook = await post('/api/cds-services/order-sign', {
    hook: 'order-sign', hookInstance: 'reg-3', code: 'J0717', planType: 'MEDICAID-MCO',
    practitionerNpi: '1234567890', patientId: 'pat-5520-maria-santos', patient: { id: 'pat-5520-maria-santos' }
  });
  check('Medicaid: no grid rule matches (no Medicaid grid ingested)', /not on the active PA grid/i.test(medHook.json?.cards?.[0]?.summary || ''), medHook.json?.cards?.[0]?.summary);
}

const PDEX_PA = 'http://hl7.org/fhir/us/davinci-pdex/StructureDefinition/pdex-priorauthorization';
const PDEX_REVIEW_ACTION = 'http://hl7.org/fhir/us/davinci-pdex/StructureDefinition/extension-reviewAction';

function pdexReview(eob) {
  for (const adj of eob?.item?.[0]?.adjudication || []) {
    const ext = (adj.extension || []).find((e) => e.url === PDEX_REVIEW_ACTION);
    if (!ext) continue;
    const sub = (u) => ext.extension.find((e) => e.url.endsWith(u));
    return {
      action: sub('extension-reviewActionCode')?.valueCodeableConcept?.coding?.[0]?.code,
      reason: sub('reasonCode')?.valueCodeableConcept?.coding?.[0]?.code,
      category: adj.category?.coding?.[0]?.code
    };
  }
  return null;
}

async function phase4() {
  console.log('\nPhase 4: drug PA in the access APIs and at the pharmacy');
  const pid = 'pat-6614-marcus-johnson';
  const deny = { diagnosis: 'M05.79', 'conventional-therapy-failed': false, 'tb-screen-negative': true };
  const med = drugPasBundle(pid, deny);
  await post('/api/pas/submit', med);
  const ben = (await post('/api/drug-pa/pharmacy', { step: 'benefit', drugKey: 'certolizumab', patientId: pid, prescriberNpi: '1234567890' })).json;
  await post('/api/drug-pa/pharmacy', { step: 'submit', drugKey: 'certolizumab', patientId: pid, prescriberNpi: '1234567890', caseId: ben?.caseId, answers: deny });

  const pTok = await token(['patient/Patient.read', 'patient/Coverage.read', 'patient/ExplanationOfBenefit.read', 'patient/ClaimResponse.read']);
  const pa = (await call('/api/patient-access?patientId=' + pid, { headers: { authorization: 'Bearer ' + pTok } })).json;
  const eobs = pa?.priorAuthorizations || [];
  const medEob = eobs.find((e) => e.type?.coding?.[0]?.code === 'professional');
  const rxEob = eobs.find((e) => e.type?.coding?.[0]?.code === 'pharmacy');
  check('Patient Access returns drug PAs from both tracks', !!medEob && !!rxEob, String(eobs.length));
  check('medical drug PA EOB claims the PDex PA profile; pharmacy (NDC) EOB does not', medEob?.meta?.profile?.[0] === PDEX_PA && !rxEob?.meta?.profile && eobs.every((e) => e.use === 'preauthorization'));
  const denialReason = medEob?.item?.[0]?.adjudication?.find((a) => a.category?.coding?.[0]?.code === 'denialreason')?.reason?.coding?.[0];
  check('denialreason slice uses a CARC code (required binding), 886 stays in reviewAction', denialReason?.system === 'https://x12.org/codes/claim-adjustment-reason-codes' && denialReason?.code === '50');
  check('medical EOB: HCPCS J0717, A3, 886 code 44, denialreason slice',
    medEob?.item?.[0]?.productOrService?.coding?.[0]?.code === 'J0717' && pdexReview(medEob)?.action === 'A3' && pdexReview(medEob)?.reason === '44' && pdexReview(medEob)?.category === 'denialreason');
  check('pharmacy EOB: NDC 50474075010, same reason 44',
    rxEob?.item?.[0]?.productOrService?.coding?.[0]?.code === '50474075010' && pdexReview(rxEob)?.reason === '44');
  check('drug PA EOB carries required elements (insurance, provider, created, quantity)',
    eobs.every((e) => e.insurance?.[0]?.coverage?.reference && (e.provider?.reference || e.provider?.display) && e.created && e.item?.[0]?.quantity?.value));

  const sTok = await token(['system/Patient.read', 'system/ExplanationOfBenefit.read', 'system/ClaimResponse.read', 'system/Coverage.read']);
  const prov = (await call('/api/provider-access?npi=1234567890', { headers: { authorization: 'Bearer ' + sTok } })).json;
  const marcus = prov?.patients?.find((p) => p.patientId === pid);
  check('Provider Access returns the same drug PAs for the attributed patient', (marcus?.priorAuthorizations || []).some((e) => pdexReview(e)?.reason === '44'));
  // The medical-track PAS Bundle above names no Practitioner, so only the
  // pharmacy track (prescriber 1234567890) belongs to this NPI's panel.
  check('Provider Access drug PAs follow the NPI (only the pharmacy track for 1234567890)',
    (marcus?.priorAuthorizations || []).length === 1 && marcus.priorAuthorizations[0].type?.coding?.[0]?.code === 'pharmacy',
    JSON.stringify((marcus?.priorAuthorizations || []).map((e) => e.type?.coding?.[0]?.code)));

  // A forced debug denial is not a model decision and stays out of the access APIs.
  const forced = { ...drugPasBundle('pat-3301-dorothy-hayes', { diagnosis: 'K50.90', 'conventional-therapy-failed': true, 'tb-screen-negative': true }), _simulateDenial: true };
  await post('/api/pas/submit', forced);
  const dorRec = (await call('/api/drug-pa/record?patientId=pat-3301-dorothy-hayes&drugKey=certolizumab')).json?.record;
  // A genuine pharmacy approval for the same patient, which must appear.
  await post('/api/drug-pa/pharmacy', { step: 'submit', drugKey: 'certolizumab', patientId: 'pat-3301-dorothy-hayes', answers: { diagnosis: 'K50.90', 'conventional-therapy-failed': true, 'tb-screen-negative': true } });
  const dor = (await call('/api/patient-access?patientId=pat-3301-dorothy-hayes', { headers: { authorization: 'Bearer ' + pTok } })).json;
  const dorEobs = dor?.priorAuthorizations || [];
  check('forced debug denial is recorded but excluded; the genuine approval is included',
    dorRec?.tracks?.medical?.debugForced === true && dorEobs.some((e) => pdexReview(e)?.action === 'A1') && !dorEobs.some((e) => pdexReview(e)?.action === 'A3'));

  const phNoTok = await call('/api/pharmacy/pa-status?memberId=BCBSIL-MEM-614&ndc=50474075010');
  check('pharmacy lookup without token → 401', phNoTok.status === 401);
  const ph = await call('/api/pharmacy/pa-status?memberId=BCBSIL-MEM-614&ndc=50474075010', { headers: { authorization: 'Bearer ' + sTok } });
  const phEobs = (ph.json?.bundle?.entry || []).map((e) => e.resource);
  check('pharmacy lookup returns both tracks with reason 44', ph.status === 200 && phEobs.length === 2 && phEobs.every((e) => pdexReview(e)?.reason === '44'));
  check('pharmacy lookup carries RTPB and F&B', ph.json?.benefit?.rtpb?.priorAuthorizationRequired === true && /formulary/i.test(ph.json?.benefit?.formulary?.formularyStatus || ''));
  const phBad = await call('/api/pharmacy/pa-status?memberId=BCBSIL-MEM-614&ndc=00000000000', { headers: { authorization: 'Bearer ' + sTok } });
  check('pharmacy lookup: unknown NDC → 404 OperationOutcome (error)', phBad.status === 404 && phBad.json?.issue?.[0]?.severity === 'error');
  const phMissing = await call('/api/pharmacy/pa-status?memberId=BCBSIL-MEM-614', { headers: { authorization: 'Bearer ' + sTok } });
  check('pharmacy lookup: missing ndc → 400 OperationOutcome', phMissing.status === 400 && phMissing.json?.resourceType === 'OperationOutcome');

  const hist = (await call('/api/payer-to-payer/history/pat-8849-jane-doe', { headers: { authorization: 'Bearer ' + sTok } })).json;
  const priorDrug = (hist?.entry || []).map((e) => e.resource).find((r) => r.resourceType === 'ExplanationOfBenefit' && r.use === 'preauthorization');
  check('Payer-to-Payer history carries a prior-plan pharmacy drug PA (use preauthorization, NDC, A1)', priorDrug?.item?.[0]?.productOrService?.coding?.[0]?.code === '50474075010' && pdexReview(priorDrug)?.action === 'A1' && pdexReview(priorDrug)?.category === 'allowedunits');
}

async function phase5() {
  console.log('\nPhase 5: reporting and metrics');
  // Start from the seeded baseline so counts can be checked exactly.
  await call('/api/demo/reset?mode=seeded', { method: 'POST' });
  const metrics = async () => (await call('/api/metrics')).json;
  const usageOf = (m, api) => m?.usage?.find((u) => u.api === api) || { success: 0, unauthenticated: 0, authFailure: 0, serverError: 0, total: 0 };

  const m0 = await metrics();
  check('after reset: PA metrics count only the seeded decision (1 medical approval)',
    m0?.priorAuthorization?.medicalItems?.requests === 1 && m0.priorAuthorization.medicalItems.approved === 1 && m0.priorAuthorization.drugs.all.requests === 0,
    JSON.stringify(m0?.priorAuthorization?.medicalItems));
  check('after reset: usage counters cleared', (m0?.usage || []).length === 0, JSON.stringify(m0?.usage));

  // Drug requests with no answers are not model decisions: a J0717 PAS with
  // no QuestionnaireResponse and a pharmacy submit with no answers.
  const noQr = drugPasBundle('pat-8849-jane-doe', {});
  noQr.entry = noQr.entry.filter((e) => e.resource.resourceType !== 'QuestionnaireResponse');
  await post('/api/pas/submit', noQr);
  await post('/api/drug-pa/pharmacy', { step: 'submit', drugKey: 'certolizumab', patientId: 'pat-8849-jane-doe', answers: {} });
  const mNo = (await metrics())?.priorAuthorization;
  check('drug requests with no answers are left out of the PA metrics', mNo?.drugs?.all?.requests === 0, JSON.stringify(mNo?.drugs?.all));
  await call('/api/demo/reset?mode=seeded', { method: 'POST' });

  const reg = await call('/api/registry/endpoints');
  const eps = (reg.json?.entry || []).map((e) => e.resource);
  check('endpoint report: 4 base FHIR Endpoint resources', reg.status === 200 && eps.length === 4 && eps.every((e) => e.resourceType === 'Endpoint' && !e.meta?.profile));
  check('endpoint addresses are absolute and under /cms-0057/api', eps.every((e) => /^https?:\/\/[^/]+\/cms-0057\/api\//.test(e.address)));
  check('endpoints use hl7-fhir-rest and FHIR JSON', eps.every((e) => e.connectionType?.code === 'hl7-fhir-rest' && e.payloadMimeType?.[0] === 'application/fhir+json'));

  // Usage buckets: no token, bad token, good token.
  const pTok = await token(['patient/Patient.read', 'patient/Coverage.read', 'patient/ExplanationOfBenefit.read', 'patient/ClaimResponse.read']);
  await call('/api/patient-access?patientId=pat-8849-jane-doe');
  await call('/api/patient-access?patientId=pat-8849-jane-doe', { headers: { authorization: 'Bearer not-a-valid-token' } });
  await call('/api/patient-access?patientId=pat-8849-jane-doe', { headers: { authorization: 'Bearer ' + pTok } });
  await call('/api/patient-access?patientId=pat-8849-jane-doe', { headers: { authorization: 'Bearer ' + pTok } });
  const u = usageOf(await metrics(), 'Patient Access');
  check('usage: no-token 401 counted apart (1)', u.unauthenticated === 1, JSON.stringify(u));
  check('usage: bad-token 401 counted as auth failure (1)', u.authFailure === 1);
  check('usage: 2 successes', u.success === 2);
  check('usage: error rate = 1 of 3 (the no-token step excluded)', u.errorRatePct === 33.3, String(u.errorRatePct));

  // PA metrics: a live approval, a pharmacy drug denial, a forced debug denial.
  await post('/api/pas/submit', pasBundle('70553'));
  const ben = (await post('/api/drug-pa/pharmacy', { step: 'benefit', drugKey: 'certolizumab', patientId: 'pat-8849-jane-doe' })).json;
  await post('/api/drug-pa/pharmacy', { step: 'submit', drugKey: 'certolizumab', patientId: 'pat-8849-jane-doe', caseId: ben?.caseId, answers: { diagnosis: 'M05.79' } });
  await post('/api/pas/submit', { ...drugPasBundle('pat-8849-jane-doe', { diagnosis: 'K50.90', 'conventional-therapy-failed': true, 'tb-screen-negative': true }), _simulateDenial: true });
  // MA pharmacy drug (Part D): excluded from the MA drug metrics.
  const rb = (await post('/api/drug-pa/pharmacy', { step: 'benefit', drugKey: 'certolizumab', patientId: 'pat-7712-robert-chen' })).json;
  await post('/api/drug-pa/pharmacy', { step: 'submit', drugKey: 'certolizumab', patientId: 'pat-7712-robert-chen', caseId: rb?.caseId, answers: { diagnosis: 'M05.79', 'conventional-therapy-failed': true, 'tb-screen-negative': true } });

  const m1 = (await metrics())?.priorAuthorization;
  check('PA metrics: medical items now 2 requests, 2 approved, 100%', m1?.medicalItems?.requests === 2 && m1.medicalItems.approved === 2 && m1.medicalItems.approvedPct === 100, JSON.stringify(m1?.medicalItems));
  check('PA metrics: forced debug denial not counted', m1?.drugs?.medicalBenefit?.requests === 0, JSON.stringify(m1?.drugs?.medicalBenefit));
  check('PA metrics: pharmacy drugs 1 request, denied (MA Part D left out of every aggregate)', m1?.drugs?.pharmacyBenefit?.requests === 1 && m1.drugs.pharmacyBenefit.denied === 1, JSON.stringify(m1?.drugs?.pharmacyBenefit));
  check('PA metrics: all drugs also leave out MA Part D', m1?.drugs?.all?.requests === 1, JSON.stringify(m1?.drugs?.all));
  check('MA-PPO drug row present from the seeded baseline', (m0?.priorAuthorization?.drugs?.byPlan || []).some((p) => p.planType === 'MA-PPO'));
  const ma = m1?.drugs?.byPlan?.find((p) => p.planType === 'MA-PPO');
  check('PA metrics: MA drug metrics exclude Part D (0 requests), with note', ma?.requests === 0 && /Part B drugs only/.test(ma?.note || ''), JSON.stringify(ma));
  const num = (x) => typeof x === 'number';
  check('PA metrics: decision times reported for items and pharmacy drugs',
    num(m1?.medicalItems?.avgDecisionSeconds) && num(m1?.medicalItems?.medianDecisionSeconds) &&
    num(m1?.drugs?.pharmacyBenefit?.avgDecisionSeconds) && num(m1?.drugs?.pharmacyBenefit?.medianDecisionSeconds),
    JSON.stringify(m1?.drugs?.pharmacyBenefit));
  const regBundle = (await call('/api/registry/endpoints')).json;
  check('endpoint report fullUrls carry no fragment and end with the resource id',
    regBundle?.entry?.length === 4 && regBundle.entry.every((e) => !String(e.fullUrl).includes('#') && String(e.fullUrl).endsWith('/Endpoint/' + e.resource.id)));
  // Malformed JSON to the pharmacy route is caught by its own validation (400).
  const badRx = await fetch(BASE + '/api/drug-pa/pharmacy', { method: 'POST', body: '{not json' });
  check('pharmacy route: malformed JSON → 400', badRx.status === 400, String(badRx.status));
  check('drug-by-plan lists every configured plan', ['COMM-HMO', 'COMM-PPO', 'MA-PPO'].every((p) => (m1?.drugs?.byPlan || []).some((r) => r.planType === p)));
  // Malformed JSON is a client error for the PA API, not a server error.
  const before = usageOf(await metrics(), 'Prior Authorization');
  const bad = await fetch(BASE + '/api/pas/submit', { method: 'POST', body: '{not json' });
  const after = usageOf(await metrics(), 'Prior Authorization');
  check('malformed JSON → 400 OperationOutcome', bad.status === 400 && (await bad.json())?.resourceType === 'OperationOutcome', String(bad.status));
  check('malformed JSON counted as client error', after.clientError === before.clientError + 1 && after.serverError === before.serverError, JSON.stringify(after));
  check('drugs requiring PA: grid J-code rules counted', m1?.drugsRequiringPa?.gridJCodeRules > 0 && m1.drugsRequiringPa.catalog.length === 1);
}

function attachmentParams(authNumber, { omit = [], final = true } = {}) {
  const p = [
    { name: 'TrackingId', valueIdentifier: { value: authNumber } },
    { name: 'AttachTo', valueCode: 'preauthorization' },
    { name: 'ProviderId', valueIdentifier: { system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' } },
    // The regression pend is for Jane Doe (pasBundle).
    { name: 'MemberId', valueIdentifier: { value: 'BCBSIL-MEM-849' } },
    {
      name: 'Attachment',
      part: [
        { name: 'LineItem', valueString: '1' },
        { name: 'Code', valueCodeableConcept: { coding: [{ system: 'http://loinc.org', code: '11506-3' }] } },
        { name: 'Content', resource: { resourceType: 'DocumentReference', status: 'current', content: [{ attachment: { contentType: 'text/plain', data: 'dGVzdA==' } }] } }
      ]
    },
    { name: 'Final', valueBoolean: final }
  ];
  return { resourceType: 'Parameters', parameter: p.filter((x) => !omit.includes(x.name)) };
}

async function phase6() {
  console.log('\nPhase 6: CDex attachments and intermediaries');
  const res = (await post('/api/pas/submit', pasBundle('15820', {}, 'MA-PPO'))).json;
  const cr = res?.entry?.[0]?.resource;
  const task = res?.entry?.map((e) => e.resource).find((r) => r.resourceType === 'Task');
  const auth = cr?.preAuthRef;
  check('pend returns a CDex attachment-request Task (PASTempCodes attachment-request-code)',
    task?.code?.coding?.[0]?.system === 'http://hl7.org/fhir/us/davinci-pas/CodeSystem/PASTempCodes' && task?.code?.coding?.[0]?.code === 'attachment-request-code');
  check('Task carries tracking-id, contained Patient and PractitionerRole, requester payer id, reason',
    task?.identifier?.[0]?.value === auth && task?.identifier?.[0]?.type?.coding?.[0]?.code === 'tracking-id' &&
    task?.contained?.some((c) => c.id === 'patient') && task?.contained?.some((c) => c.id === 'practitionerrole') &&
    task?.for?.reference === '#patient' && task?.owner?.reference === '#practitionerrole' && !!task?.requester?.identifier?.value &&
    task?.reasonCode?.coding?.[0]?.code === 'preauthorization' && task?.reasonReference?.identifier?.value === auth);
  const payerUrl = task?.input?.find((i) => i.type?.coding?.[0]?.code === 'payer-url')?.valueUrl;
  check('Task payer-url is absolute and points at $submit-attachment', /^https?:\/\/.+\/cms-0057\/api\/cdex\/\$submit-attachment$/.test(payerUrl || ''), payerUrl);

  await sleep(8500);
  const waiting = (await call('/api/pas/pended/' + auth)).json;
  check('pend waits for the attachment (no auto-finalize)', waiting?.status === 'pended', waiting?.status);

  const bad = await post('/api/cdex/$submit-attachment', attachmentParams(auth, { omit: ['MemberId'] }));
  check('$submit-attachment without MemberId → 400', bad.status === 400 && /MemberId/.test(bad.json?.issue?.[0]?.diagnostics || ''));
  const noProv = await post('/api/cdex/$submit-attachment', attachmentParams(auth, { omit: ['ProviderId'] }));
  check('$submit-attachment without ProviderId or OrganizationId → 400', noProv.status === 400);
  const dupAttachTo = attachmentParams(auth);
  dupAttachTo.parameter.push({ name: 'AttachTo', valueCode: 'claim' });
  const dup = await post('/api/cdex/$submit-attachment', dupAttachTo);
  check('$submit-attachment with two AttachTo → 400', dup.status === 400);
  const unknown = await post('/api/cdex/$submit-attachment', attachmentParams('AUTH-NOPE'));
  check('$submit-attachment for an unknown TrackingId → 404', unknown.status === 404);
  const notFinal = await post('/api/cdex/$submit-attachment', attachmentParams(auth, { final: false }));
  check('non-final attachment accepted, request keeps waiting', notFinal.status === 200 && (await call('/api/pas/pended/' + auth)).json?.status === 'pended');
  const wrongMember = await post('/api/cdex/$submit-attachment', {
    ...attachmentParams(auth),
    parameter: attachmentParams(auth).parameter.map((p) => (p.name === 'MemberId' ? { name: 'MemberId', valueIdentifier: { value: 'BCBSIL-MEM-712' } } : p))
  });
  check('attachment for a different member → 422', wrongMember.status === 422);
  const ok = await post('/api/cdex/$submit-attachment', attachmentParams(auth));
  check('final attachment accepted (200 OperationOutcome)', ok.status === 200 && ok.json?.resourceType === 'OperationOutcome');
  check('still pended right after the final attachment (review window running)', (await call('/api/pas/pended/' + auth)).json?.status === 'pended');
  const during = await post('/api/cdex/$submit-attachment', attachmentParams(auth));
  check('another attachment during review → 409 (window not restarted)', during.status === 409);
  await sleep(8500);
  const fin = (await call('/api/pas/pended/' + auth)).json;
  const finCr = fin?.responseBundle?.entry?.[0]?.resource;
  check('re-adjudicated after the review window → A1 citing the attachment', fin?.status === 'finalized' && review(finCr)?.action === 'A1' && /submitted attachment/.test(finCr?.disposition || ''));
  const again = await post('/api/cdex/$submit-attachment', attachmentParams(auth));
  check('attachment after finalization → 409', again.status === 409);

  // Clearinghouse conformance hop.
  const pasProfile = 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-pas-request-bundle';
  const withProfile = (p) => ({ ...pasBundle('70553'), meta: p ? { profile: [p] } : undefined });
  const good = await post('/api/clearinghouse/pas', withProfile(pasProfile + '|2.2.1'));
  check('clearinghouse forwards a PAS 2.2.1 Bundle to the payer → A1', good.status === 200 && review(good.json?.entry?.[0]?.resource)?.action === 'A1');
  const prior = await post('/api/clearinghouse/pas', withProfile(pasProfile + '|2.0.1'));
  check('clearinghouse accepts PAS 2.0.1 (in 170.215 until the proposed 2028 expiry)', prior.status === 200);
  const old = await post('/api/clearinghouse/pas', withProfile(pasProfile + '|1.1.0'));
  check('clearinghouse rejects PAS 1.1.0 with a 422 OperationOutcome', old.status === 422 && /1\.1\.0/.test(old.json?.issue?.[0]?.diagnostics || ''));
  const objEntry = await post('/api/clearinghouse/pas', { resourceType: 'Bundle', type: 'collection', meta: { profile: [pasProfile + '|2.2.1'] }, entry: { resource: { resourceType: 'Claim' } } });
  check('clearinghouse: non-array entry → 422, not 500', objEntry.status === 422);
  const objPas = await post('/api/pas/submit', { resourceType: 'Bundle', type: 'collection', entry: { resource: { resourceType: 'Claim' } } });
  check('PAS: non-array entry → validation error ClaimResponse, not 500', objPas.status === 200 && objPas.json?.entry?.[0]?.resource?.outcome === 'error');
  const objAtt = await post('/api/cdex/$submit-attachment', { resourceType: 'Parameters', parameter: { name: 'TrackingId' } });
  check('$submit-attachment: non-array parameter → 400, not 500', objAtt.status === 400);
  const none = await post('/api/clearinghouse/pas', withProfile(null));
  check('clearinghouse rejects a Bundle without the PAS profile', none.status === 422);
  const unversioned = await post('/api/clearinghouse/pas', withProfile(pasProfile));
  check('clearinghouse forwards an unversioned profile (warning only)', unversioned.status === 200);
  // A client that sends a content-length for pretty-printed JSON still works.
  const pretty = JSON.stringify(withProfile(pasProfile + '|2.2.1'), null, 2);
  const prettyRes = await fetch(BASE + '/api/clearinghouse/pas', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(pretty)) }, body: pretty });
  check('clearinghouse forwards pretty-printed JSON', prettyRes.status === 200);
  const m = (await call('/api/metrics')).json;
  const ch = m?.usage?.find((u) => u.api === 'Clearinghouse');
  check('clearinghouse calls are metered under Clearinghouse', ch?.total >= 6, JSON.stringify(ch));
  const rejLog = await logsFor(/^CLEARINGHOUSE REJECTED$/);
  check('rejections are logged to the feed', rejLog.length >= 2);
}

async function phase7() {
  console.log('\nPhase 7: US Core 6.1.0 Patient');
  const pTok = await token(['patient/Patient.read', 'patient/Coverage.read', 'patient/ExplanationOfBenefit.read', 'patient/ClaimResponse.read']);
  const ALL = ['pat-8849-jane-doe', 'pat-7712-robert-chen', 'pat-3301-dorothy-hayes', 'pat-6614-marcus-johnson', 'pat-5520-maria-santos', 'pat-4410-david-kim'];
  for (const pid of ALL) {
    const p = (await call('/api/patient-access?patientId=' + pid, { headers: { authorization: 'Bearer ' + pTok } })).json?.patient;
    check(pid + ': profile us-core-patient|6.1.0', p?.meta?.profile?.[0] === 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient|6.1.0');
    check(pid + ': identifier has system and value (1..*)', p?.identifier?.length > 0 && p.identifier.every((i) => i.system && i.value));
    check(pid + ': name meets us-core-6 (family or given)', p?.name?.length > 0 && p.name.every((n) => n.family || n.given?.length));
    check(pid + ': gender present (1..1)', ['male', 'female', 'other', 'unknown'].includes(p?.gender));
    check(pid + ': Must Support birthDate, address, telecom, communication.language',
      !!p?.birthDate && !!p?.address?.[0]?.postalCode && p?.telecom?.[0]?.system === 'phone' && !!p?.communication?.[0]?.language?.coding?.[0]?.code);
    // Sub-extensions matched by url, not position.
    const sub = (u, s) => (p?.extension || []).find((e) => e.url === u)?.extension?.find((x) => x.url === s);
    const RACE = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-race';
    const ETH = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-ethnicity';
    check(pid + ': race and ethnicity recorded as ASKU with the required text',
      sub(RACE, 'ombCategory')?.valueCoding?.code === 'ASKU' && !!sub(RACE, 'text')?.valueString &&
      sub(ETH, 'ombCategory')?.valueCoding?.code === 'ASKU' && !!sub(ETH, 'text')?.valueString);
  }
}

async function hardening() {
  console.log('\nSuper-review hardening: tokens and scopes');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const pScopes = ['patient/Patient.read', 'patient/Coverage.read', 'patient/ExplanationOfBenefit.read', 'patient/ClaimResponse.read'];
  const pTok = await token(pScopes);
  const [h, , sig] = pTok.split('.');
  const tampered = [h, b64({ iss: 'cms-0057-sandbox-auth', aud: 'cms-0057-sandbox-fhir', exp: 4102444800, scope: pScopes.join(' ') }), sig].join('.');
  const PA = '/api/patient-access?patientId=pat-8849-jane-doe';
  const auth = (t) => ({ headers: { authorization: 'Bearer ' + t } });
  check('good token → 200 (positive control)', (await call(PA, auth(pTok))).status === 200);
  check('tampered payload → 401', (await call(PA, auth(tampered))).status === 401);
  const none = [b64({ alg: 'none', typ: 'JWT' }), tampered.split('.')[1], ''].join('.');
  check('alg none → 401', (await call(PA, auth(none))).status === 401);
  const hs = [b64({ alg: 'HS512', typ: 'JWT' }), tampered.split('.')[1], sig].join('.');
  check('wrong alg → 401', (await call(PA, auth(hs))).status === 401);
  check('header that decodes to null → 401, not 500', (await call(PA, auth('bnVsbA.a.b'))).status === 401);
  const sTok = await token(['system/Patient.read', 'system/ExplanationOfBenefit.read', 'system/ClaimResponse.read']);
  check('patient-scoped token on Provider Access → 403', (await call('/api/provider-access?npi=1234567890', auth(pTok))).status === 403);
  check('Provider Access without a token → 401', (await call('/api/provider-access?npi=1234567890')).status === 401);
  const pv = (await call('/api/provider-access?npi=1234567890', auth(sTok))).json;
  check('Provider Access panel is not empty for the demo NPI', (pv?.patients || []).length > 0);
  check('member-match without a token → 401', (await post('/api/payer-to-payer/member-match', { resourceType: 'Parameters', parameter: [] })).status === 401);
  check('P2P history without a token → 401', (await call('/api/payer-to-payer/history/pat-7712-robert-chen')).status === 401);
  const p2pTok = await token(['system/Patient.read', 'system/Coverage.read', 'system/ExplanationOfBenefit.read', 'system/ClaimResponse.read']);
  check('P2P history for an inherited key (constructor) → 404', (await call('/api/payer-to-payer/history/constructor', auth(p2pTok))).status === 404);
  const disc = await call('/api/.well-known/smart-configuration');
  check('SMART discovery advertises only what the token endpoint does', disc.status === 200 && /\/cms-0057\/api\/auth\/token$/.test(disc.json?.token_endpoint || '') &&
    !(disc.json?.capabilities || []).some((c) => /client-confidential|permission-v2/.test(c)));

  console.log('\nSuper-review hardening: request bodies');
  check('order-sign with JSON null → 400', (await post('/api/cds-services/order-sign', null)).status === 400);
  check('PAS submit with a JSON array → 400', (await post('/api/pas/submit', [])).status === 400);
  const badJson = await fetch(BASE + '/api/pas/submit', { method: 'POST', body: '{not json', headers: { 'content-type': 'application/json' } });
  check('PAS submit with invalid JSON → 400', badJson.status === 400);
  check('pharmacy drug track with a numeric planType → 400', (await post('/api/drug-pa/pharmacy', { step: 'submit', drugKey: 'certolizumab', patientId: 'x', planType: 123 })).status === 400);
  check('pharmacy drug track with drugKey constructor → 400', (await post('/api/drug-pa/pharmacy', { step: 'benefit', drugKey: 'constructor', patientId: 'x' })).status === 400);
  check('metrics still 200 after the bad requests', (await call('/api/metrics')).status === 200);
  // A bad match_type fails before any merge, so this probe can never reach
  // the committed snapshot even if other checks regress.
  check('commit-rules rejects a malformed rule → 400', (await post('/api/commit-rules', [{ match_type: 'bogus', service_code: '99999' }])).status === 400);
  check('PAS submit with an unknown planType → 400', (await post('/api/pas/submit', { ...pasBundle('70553'), planType: 123 })).status === 400);
  check('Provider Access without an npi → 400', (await call('/api/provider-access', auth(sTok))).status === 400);
  check('unauthenticated member-match with a bad body → 401 (auth runs first)',
    (await fetch(BASE + '/api/payer-to-payer/member-match', { method: 'POST', body: '{bad', headers: { 'content-type': 'application/json' } })).status === 401);
  const sameMs = await Promise.all([post('/api/pas/submit', pasBundle('70553')), post('/api/pas/submit', pasBundle('70553'))]);
  const refs = sameMs.map((r) => r.json?.entry?.[0]?.resource?.preAuthRef);
  check('two concurrent approvals get different auth numbers', refs[0] && refs[1] && refs[0] !== refs[1], refs.join(' '));
  check('commit-rules rejects a non-array body → 400', (await post('/api/commit-rules', { rules: [] })).status === 400);

  console.log('\nSuper-review hardening: CRD and X12');
  const goldNoNpi = (await post('/api/cds-services/order-sign', { hook: 'order-sign', hookInstance: 'reg-g1', code: '27447', planType: 'COMM-PPO', patientId: 'pat-3301-dorothy-hayes', patient: { id: 'pat-3301-dorothy-hayes' } })).json;
  check('gold card needs an enrolled NPI (none sent → no exemption)', !/gold-card/.test(goldNoNpi?.cards?.[0]?.summary || ''), goldNoNpi?.cards?.[0]?.summary);
  const gold = (await post('/api/cds-services/order-sign', { hook: 'order-sign', hookInstance: 'reg-g2', code: '27447', planType: 'COMM-PPO', practitionerNpi: 'GOLD-NPI-0001', patientId: 'pat-3301-dorothy-hayes', patient: { id: 'pat-3301-dorothy-hayes' } })).json;
  const CI = 'http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information';
  const ciParts = (res) => (res?.extension || []).find((e) => e.url === CI)?.extension || [];
  const ciPart = (res, name) => ciParts(res).find((e) => e.url === name);
  const goldOrder = gold?.systemActions?.[0]?.resource;
  check('gold card: card and order coverage-information agree (satisfied, with a satisfied-pa-id)',
    /gold-card/.test(gold?.cards?.[0]?.summary || '') && ciPart(goldOrder, 'pa-needed')?.valueCode === 'satisfied' && !!ciPart(goldOrder, 'satisfied-pa-id')?.valueString,
    JSON.stringify(ciParts(goldOrder)));
  check('CRD coverage-information is one complex extension on the order (relative sub-extensions, valueDate)',
    goldOrder?.resourceType === 'ServiceRequest' && ciParts(goldOrder).every((e) => !e.url.includes('#') && !e.url.startsWith('http')) &&
    /^\d{4}-\d{2}-\d{2}$/.test(ciPart(goldOrder, 'date')?.valueDate || '') && !!ciPart(goldOrder, 'coverage-assertion-id'));
  const drugHook = (await post('/api/cds-services/order-sign', { hook: 'order-sign', hookInstance: 'reg-g3', code: 'J0717', planType: 'COMM-PPO', practitionerNpi: '1234567890', patientId: 'pat-8849-jane-doe', patient: { id: 'pat-8849-jane-doe' } })).json;
  const drugOrder = drugHook?.systemActions?.[0]?.resource;
  check('J0717 is coded as HCPCS, not CPT', drugOrder?.code?.coding?.[0]?.system === 'https://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets' &&
    ciPart(drugOrder, 'billingCode')?.valueCoding?.system === 'https://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets');
  const approvedBundle = (await post('/api/pas/submit', pasBundle('70553'))).json;
  const approvedOrder = approvedBundle?.entry?.map((e) => e.resource).find((r) => r.resourceType === 'ServiceRequest');
  check('PAS approval returns the order with pa-needed satisfied and the auth number as satisfied-pa-id',
    ciPart(approvedOrder, 'pa-needed')?.valueCode === 'satisfied' && ciPart(approvedOrder, 'satisfied-pa-id')?.valueString === approvedBundle?.entry?.[0]?.resource?.preAuthRef);
  check('ClaimResponse.type defaults to professional', approvedBundle?.entry?.[0]?.resource?.type?.coding?.[0]?.code === 'professional');
  const inj = pasBundle('70553');
  inj.entry[0].resource.name = [{ family: 'Doe~NM1*XX', given: ['Jane'] }];
  await post('/api/pas/submit', inj);
  const x12 = String((await logsFor(/^X12 278 REQUEST$/))[0]?.details?.x12 || '');
  check('X12 delimiters in Bundle values are neutralized', x12.includes('DOE NM1 XX') && !x12.includes('~NM1*XX'));
  check('X12 278: UM01 HS, procedure in SV1 (HC), no ICD-9 BK qualifier', /\nUM\*HS\*I\*/.test(x12) && x12.includes('SV1*HC:70553') && !x12.includes('HI*BK:'));
  const dxBundle = pasBundle('70553');
  dxBundle.entry[1].resource.diagnosis = [{ sequence: 1, diagnosisCodeableConcept: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'G43.909' }] } }];
  await post('/api/pas/submit', dxBundle);
  const dxX12 = String((await logsFor(/^X12 278 REQUEST$/))[0]?.details?.x12 || '');
  check('X12 278: Claim.diagnosis → HI*ABK (ICD-10, no decimal)', dxX12.includes('HI*ABK:G43909'));
  const numeric = pasBundle('70553');
  numeric.entry[0].resource.name = [{ family: 42 }];
  check('numeric family name → no 500', (await post('/api/pas/submit', numeric)).status === 200);
  const pasProfile = 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-pas-request-bundle';
  const mixed = { ...pasBundle('70553'), meta: { profile: [pasProfile, pasProfile + '|1.1.0'] } };
  check('clearinghouse checks every PAS profile claim (unversioned + 1.1.0 → 422)', (await post('/api/clearinghouse/pas', mixed)).status === 422);
}

// Phase checks are appended below as each phase lands.
const PHASES = [baseline, phase1, phase2, phase3, phase4, phase5, phase6, phase7, hardening];

console.log(`Regression against ${BASE}`);
// Start from the seeded baseline, whatever state the server was left in.
const startReset = await call('/api/demo/reset?mode=seeded', { method: 'POST' });
check('reset to the seeded baseline before the run', startReset.status === 200);
for (const phase of PHASES) await phase();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
