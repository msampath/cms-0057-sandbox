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

// Each step: a page, an optional /um tab, optional buttons to click (by
// visible text, in order), and text that must appear afterwards. The clicks
// exercise client fetches, so a fetch that skipped apiUrl() 404s here.
const STEPS = [
  { path: '/', expect: ['156.223', '156.222(a)', '156.222(b)', '156.221(a)'] },
  { path: '/ehr', click: ['Sign Order'], expect: ['Prior authorization required', 'Launch DTR'] },
  { path: '/patient', expect: ['156.221(a)'] },
  { path: '/um', tab: 'Rules & Schema', expect: ['Payer Interop Gateway'] },
  {
    path: '/um',
    tab: 'Live Traffic Feed',
    click: ['Show FHIR ↔ X12 translation'],
    expect: ['FHIR PAS, proposed HIPAA standard', '162.1302', 'X12 278 — parallel projection']
  },
  { path: '/um', tab: 'Provider Access', click: ['Retrieve panel'], expect: ['156.222(a)', 'pat-8849-jane-doe'] },
  { path: '/um', tab: 'P2P Exchange', click: ['Request prior plan data'], expect: ['156.222(b)', 'Step 3', 'DENIED'] },
  { path: '/um', tab: 'Standards', expect: ['Sunset marker', '2.2.1', 'January 1, 2028'] }
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
page.on('response', (r) => {
  if ((r.status() === 404 || r.status() >= 500) && !IGNORED_URLS.some((re) => re.test(r.url()))) {
    errors.push(`HTTP ${r.status()} ${r.url()}`);
  }
});

console.log(`UI smoke against ${BASE}`);
for (const step of STEPS) {
  const label = step.tab ? `${step.path} [${step.tab}]` : step.path;
  errors.length = 0;
  try {
    await page.goto(`${BASE}${step.path}`, { waitUntil: 'networkidle' });
    if (step.tab) {
      await page.getByRole('button', { name: new RegExp(`^${step.tab.replace(/[&]/g, '\\$&')}`) }).first().click();
      await page.waitForTimeout(600);
    }
    for (const buttonName of step.click || []) {
      await page.getByRole('button', { name: buttonName }).first().click();
      await settle();
    }
    // Let in-flight requests settle so a slow 404 is charged to this step
    // instead of being cleared when the next step starts.
    await settle();
    const text = await page.locator('body').innerText();
    // innerText reflects CSS text-transform, so compare case-insensitively.
    const haystack = text.toLowerCase();
    const missing = step.expect.filter((t) => !haystack.includes(t.toLowerCase()));
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
