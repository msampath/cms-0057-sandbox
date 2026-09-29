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

  const bad = await post('/api/drug-pa/pharmacy', { step: 'submit', drugKey: 'nope', patientId: pid });
  check('pharmacy route rejects unknown drug with 400', bad.status === 400);
  const ncpdp = await logsFor(/^NCPDP PA RESPONSE/);
  check('feed has structured NCPDP entries', ncpdp.length > 0 && ncpdp[0].details?.kind === 'ncpdp');
}

// Phase checks are appended below as each phase lands.
const PHASES = [baseline, phase1, phase2];

console.log(`Regression against ${BASE}`);
for (const phase of PHASES) await phase();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
