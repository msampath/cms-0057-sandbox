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
  await sleep(8500);
  const fin = await call(`/api/pas/pended/${pend?.preAuthRef}`);
  const finCr = fin.json?.responseBundle?.entry?.[0]?.resource;
  check('pended request finalizes to A1', fin.status === 200 && review(finCr)?.action === 'A1', fin.json?.status);

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
  check('Patient profile is US Core, unversioned (3.1.1 expired)', res('Patient') === 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient', res('Patient'));
  check('US Core IG listed unversioned (3.1.1 expired)', igs.includes('http://hl7.org/fhir/us/core/ImplementationGuide/hl7.fhir.us.core'));
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
  await post('/api/pas/submit', bare);
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
    eobs.every((e) => e.insurance?.[0]?.coverage?.reference && e.provider?.reference && e.created && e.item?.[0]?.quantity?.value));

  const sTok = await token(['system/Patient.read', 'system/ExplanationOfBenefit.read', 'system/ClaimResponse.read', 'system/Coverage.read']);
  const prov = (await call('/api/provider-access?npi=1234567890', { headers: { authorization: 'Bearer ' + sTok } })).json;
  const marcus = prov?.patients?.find((p) => p.patientId === pid);
  check('Provider Access returns the same drug PAs for the attributed patient', (marcus?.priorAuthorizations || []).some((e) => pdexReview(e)?.reason === '44'));

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

// Phase checks are appended below as each phase lands.
const PHASES = [baseline, phase1, phase2, phase3, phase4];

console.log(`Regression against ${BASE}`);
for (const phase of PHASES) await phase();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
