/**
 * UI smoke checks against a running server. Loads every surface and /um
 * tab, checks that expected text renders, and fails on console errors.
 *
 *   npm run ui-smoke                        (defaults to http://localhost:3000/cms-0057)
 *
 * Complements scripts/regression.mjs, which covers the API behavior.
 */
import { chromium } from 'playwright';

const BASE = (process.env.BASE_URL || 'http://localhost:3000/cms-0057').replace(/\/$/, '');

// Each step: a page, an optional /um tab, an optional preset order to pick
// in /ehr (matched by option text), optional buttons to click (by visible
// text, in order), and text that must appear afterwards. The clicks
// exercise client fetches, so a fetch that skipped apiUrl() 404s here.
const STEPS = [
  { path: '/', expect: ['156.223', '156.222(a)', '156.222(b)', '156.221(a)'] },
  {
    path: '/ehr',
    click: ['Sign Order'],
    // Against a server with no Optum or Availity credentials (the default
    // locally) both panels must say they show a saved copy. Set
    // SMOKE_LIVE_INTEGRATIONS=1 when running against a live-credential server.
    expect: process.env.SMOKE_LIVE_INTEGRATIONS
      ? ['Prior authorization required', 'Launch DTR', 'Optum sandbox response', 'Availity sandbox response']
      : ['Prior authorization required', 'Launch DTR', 'Optum sandbox response (saved copy)', 'Availity sandbox response (saved copy)'],
    expectAbsent: process.env.SMOKE_LIVE_INTEGRATIONS ? ['Optum Real', 'real CRD engine', '(saved copy)'] : ['Optum Real', 'real CRD engine']
  },
  {
    path: '/ehr',
    selectOrder: 'self-administered syringe',
    click: ['Sign Order'],
    formSelect: 'M05.79',
    submit: 'Submit ePA (PARequest)',
    expect: ['Pharmacy benefit', 'RTPB v13', 'F&B v60', 'PAResponse: Denied', 'Step therapy not met', 'Shared drug PA record']
  },
  {
    path: '/ehr',
    selectOrder: 'clinic-administered',
    click: ['Sign Order', 'Launch DTR SMART App'],
    // No formSelect: the diagnosis must arrive from the shared record.
    expectSelectValue: 'M05.79',
    submit: 'Submit PAS Request',
    // The pharmacy step above left answers on the shared record for this
    // patient, so the DTR form must say it carried them over. The DTR panel
    // closes on submit, so that is checked before submitting.
    expectBeforeSubmit: ['Answers carried over from the pharmacy-benefit'],
    expect: ['Prior Authorization Denied', 'Reason code: 44', 'Shared drug PA record']
  },
  {
    // Scenario cards set the default order (self-administered certolizumab).
    path: '/ehr',
    name: 'Medicaid clock',
    click: ['Maria Santos', 'Sign Order'],
    formSelect: 'M05.79',
    submit: 'Submit ePA (PARequest)',
    // Submitting logs a Medicaid decision with a live clock for the feed step.
    expect: ['Decision clock', '24 hours', '72-hour emergency supply', '1927(d)(5)(A)', 'PAResponse: Denied']
  },
  {
    path: '/ehr',
    name: 'FFE QHP clock',
    click: ['David Kim', 'Sign Order'],
    expect: ['72 hours', 'proposed, not yet in effect', 'FFE issuer exception', '2028-06-30']
  },
  // Jane Doe has drug PAs from the /ehr drug steps above.
  {
    // MA pend with a CDex attachment request, answered from the EHR.
    path: '/ehr',
    name: 'CDex pend',
    click: ['Robert Chen'],
    // The scenario click resets the order, so the order is picked after it.
    reselectOrder: '15820',
    thenClick: ['Sign Order', 'Launch DTR SMART App'],
    fillFiles: true,
    submit: 'Submit PAS Request',
    afterSubmitClick: ['Submit requested attachment'],
    waitMs: 12000,
    expect: ['Prior Authorization Approved', 'submitted attachment']
  },
  {
    path: '/ehr',
    name: 'clearinghouse rejects PAS 1.1.0',
    click: ['Sign Order', 'Launch DTR SMART App'],
    checkLabels: ['clearinghouse', 'claim PAS 1.1.0'],
    fillFiles: true,
    formText: 'Test statement.',
    submit: 'Submit PAS Request',
    // The CRD order stays on screen after a rejected submit.
    expect: ['Rejected by the clearinghouse before reaching the payer', '1.1.0 is not accepted', 'coverage-information on the order']
  },
  {
    path: '/ehr',
    name: 'hard stop',
    checkLabels: ['hard-stop'],
    submit: 'Sign Order',
    // A blocked order gets no second opinions.
    expect: ['Order blocked'],
    expectAbsent: ['Optum sandbox response', 'Availity sandbox response']
  },
  { path: '/patient', name: 'drug PAs', click: ['Jane Doe'], expect: ['Drug prior authorizations', 'Profile: PDex Prior Authorization', 'X12 886 44'] },
  { path: '/pharmacy', click: ['Look up PA status'], expect: ['PA status for Certolizumab', 'X12 886 44', 'RTPB', 'F&B formulary'] },
  { path: '/patient', name: 'Medicaid member', click: ['Maria Santos'], expect: ['156.221(a)', 'Blue Cross Community Health Plans', 'US Core 6.1.0'] },
  { path: '/patient', name: 'FFE QHP member', click: ['David Kim'], expect: ['Individual market QHP on an FFE (illustrative)'] },
  { path: '/um', tab: 'Rules & Schema', expect: ['Showing the first 200'] },
  {
    path: '/um',
    tab: 'Live Traffic Feed',
    // Decision clock text comes from the badge on decision entries.
    click: ['Show FHIR ↔ X12 translation', 'Show NCPDP messages'],
    expect: ['FHIR PAS, proposed HIPAA standard', '162.1302', 'X12 278 — parallel projection', '<Message version="2023011">', 'not certified NCPDP payloads', 'Decision clock:', '24 hours', '1927(d)(5)(A)']
  },
  {
    path: '/um',
    tab: 'Provider Access',
    click: ['Retrieve panel', 'Jane Doe'],
    expect: ['156.222(a)', 'pat-8849-jane-doe', 'Drug prior authorizations'],
    expectAbsent: ['Optum real', 'reached a real implementation']
  },
  { path: '/um', tab: 'P2P Exchange', click: ['Request prior plan data'], expect: ['156.222(b)', 'Step 3', 'DENIED', 'Prior plan drug prior authorizations', '50474075010'] },
  { path: '/um', tab: 'Standards', expect: ['Sunset marker', '2.2.1', 'January 1, 2028', '3.1.1 expired January 1, 2026'], expectAbsent: ['3.1.1expired version'] },
  {
    path: '/um',
    tab: 'Registry & Metrics',
    click: ['Send a call with a bad token', 'Send a valid call'],
    expect: ['Endpoint report', 'Patient Access API', '/cms-0057/api/patient-access', 'Error rate', 'Prior authorization metrics', 'J-code rules']
  }
];

// Resource-load failures are checked by URL in the response handler below,
// so the generic console line for them is skipped here. /favicon.ico lives
// outside the /cms-0057 basePath and 404s by design. A 404 or 5xx on
// anything else fails the step, which is how a client fetch that skipped
// apiUrl() shows up.
const IGNORED_ERRORS = [/^Failed to load resource/];
const IGNORED_URLS = [/\/favicon\.ico$/];

let failures = 0;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' && !IGNORED_ERRORS.some((re) => re.test(m.text()))) errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(e.message));

// In-flight request count, so a step waits for requests started by a tab
// click. waitForLoadState('networkidle') returns at once after the first
// navigation reaches idle, so it cannot do this.
let inflight = 0;
page.on('request', () => inflight++);
page.on('requestfinished', () => inflight--);
page.on('requestfailed', () => inflight--);
async function settle(quietMs = 500, maxMs = 10000) {
  const start = Date.now();
  let quietSince = Date.now();
  while (Date.now() - start < maxMs) {
    if (inflight > 0) quietSince = Date.now();
    else if (Date.now() - quietSince >= quietMs) return;
    await page.waitForTimeout(100);
  }
}
// Any 4xx or 5xx fails the step, apart from the scripted ones: the
// Registry tab's deliberate bad-token call and the clearinghouse rejection.
const EXPECTED = [
  // The Registry & Metrics tab's deliberate bad-token call.
  (r) => r.status() === 401 && r.request().headers().authorization === 'Bearer not-a-valid-token',
  (r) => r.status() === 422 && /\/api\/clearinghouse\/pas$/.test(r.url())
];
// Every PAS request Bundle the EHR sends must carry the R4 Claim elements
// and no Patient.condition (not an R4 element).
page.on('request', (req) => {
  if (req.method() !== 'POST' || !/\/api\/(pas\/submit|clearinghouse\/pas)$/.test(req.url())) return;
  let b;
  try { b = req.postDataJSON(); } catch { errors.push('PAS request body is not JSON'); return; }
  const res = (t) => (b?.entry || []).map((e) => e.resource).find((r) => r?.resourceType === t);
  const claim = res('Claim');
  const missing = ['type', 'created', 'provider', 'insurer', 'insurance', 'priority'].filter((k) => !claim?.[k] || (Array.isArray(claim[k]) && !claim[k].length));
  if (missing.length) errors.push(`PAS Claim is missing ${missing.join(', ')}`);
  if (res('Patient')?.condition) errors.push('PAS Patient carries condition, which R4 does not define');
});
page.on('response', (r) => {
  if (r.status() >= 400 && !IGNORED_URLS.some((re) => re.test(r.url())) && !EXPECTED.some((ok) => ok(r))) {
    errors.push(`HTTP ${r.status()} ${r.url()}`);
  }
});

console.log(`UI smoke against ${BASE}`);
// Start from the seeded baseline, whatever state the server was left in.
const startReset = await fetch(`${BASE}/api/demo/reset?mode=seeded`, { method: 'POST' });
if (!startReset.ok) {
  console.log(`  FAIL  reset to the seeded baseline -- HTTP ${startReset.status}`);
  process.exit(1);
}
for (const step of STEPS) {
  const label = `${step.path}${step.tab ? ` [${step.tab}]` : ''}${step.selectOrder ? ` (${step.selectOrder})` : ''}${step.name ? ` (${step.name})` : ''}`;
  errors.length = 0;
  try {
    await page.goto(`${BASE}${step.path}`, { waitUntil: 'networkidle' });
    if (step.tab) {
      await page.getByRole('button', { name: new RegExp(`^${step.tab.replace(/[&]/g, '\\$&')}`) }).first().click();
      await page.waitForTimeout(600);
    }
    // Order: click, selectOrder, thenClick, checkLabels, fill, submit,
    // afterSubmitClick, wait.
    if (step.selectOrder) {
      const select = page.locator('select').nth(1);
      const value = await select.locator('option', { hasText: step.selectOrder }).first().getAttribute('value');
      await select.selectOption(value);
    }
    for (const buttonName of step.click || []) {
      await page.getByRole('button', { name: buttonName }).first().click();
      await settle();
    }
    if (step.reselectOrder) {
      const select = page.locator('select').nth(1);
      const value = await select.locator('option', { hasText: step.reselectOrder }).first().getAttribute('value');
      await select.selectOption(value);
    }
    for (const buttonName of step.thenClick || []) {
      await page.getByRole('button', { name: buttonName }).first().click();
      await settle();
    }
    for (const label of step.checkLabels || []) {
      await page.locator('label', { hasText: label }).first().locator('input[type=checkbox]').check();
    }
    if (step.fillFiles) {
      const files = page.locator('form input[type=file]');
      for (let i = 0; i < (await files.count()); i++) {
        await files.nth(i).setInputFiles({ name: 'doc.pdf', mimeType: 'application/pdf', buffer: Buffer.from('test') });
      }
    }
    if (step.formText) {
      const areas = page.locator('form textarea');
      for (let i = 0; i < (await areas.count()); i++) await areas.nth(i).fill(step.formText);
    }
    // Fill the form's diagnosis select (booleans stay unchecked, which the
    // shared model decides as step therapy not met), then submit.
    if (step.formSelect) {
      await page.locator('form select').first().selectOption(step.formSelect);
    }
    if (step.expectSelectValue) {
      const v = await page.locator('form select').first().inputValue();
      if (v !== step.expectSelectValue) errors.push(`form select is "${v}", expected carried-over "${step.expectSelectValue}"`);
    }
    if (step.expectBeforeSubmit) {
      const before = (await page.locator('body').innerText()).toLowerCase();
      for (const t of step.expectBeforeSubmit) {
        if (!before.includes(t.toLowerCase())) errors.push(`missing before submit: ${t}`);
      }
    }
    if (step.submit) {
      await page.getByRole('button', { name: step.submit }).first().click();
      await settle(800, 15000);
    }
    for (const buttonName of step.afterSubmitClick || []) {
      await page.getByRole('button', { name: buttonName }).first().click();
      await settle();
    }
    if (step.waitMs) {
      await page.waitForTimeout(step.waitMs);
      await settle();
    }
    // Let in-flight requests settle so a slow 404 is charged to this step
    // instead of being cleared when the next step starts.
    await settle();
    const text = await page.locator('body').innerText();
    // innerText reflects CSS text-transform, so compare case-insensitively.
    const haystack = text.toLowerCase();
    const missing = step.expect.filter((t) => !haystack.includes(t.toLowerCase()));
    for (const t of step.expectAbsent || []) {
      if (haystack.includes(t.toLowerCase())) errors.push(`unexpected text: ${t}`);
    }
    if (missing.length || errors.length) {
      failures++;
      console.log(`  FAIL  ${label}${missing.length ? ` -- missing: ${missing.join(', ')}` : ''}${errors.length ? ` -- console: ${errors.join(' | ')}` : ''}`);
    } else {
      console.log(`  ok    ${label}`);
    }
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${label} -- ${e.message.split('\n')[0]}`);
  }
}
await browser.close();
console.log(`\n${STEPS.length - failures} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
