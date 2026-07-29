/**
 * Capture the README / portfolio screenshots against a running server.
 *
 *   npm run screenshots
 *   BASE_URL=https://surakshith.com/cms-0057 npm run screenshots
 *
 * Requires a running instance (default http://localhost:3000/cms-0057).
 * Resets the demo to the seeded baseline first so shots are reproducible,
 * then drives the Jane Doe 70553 arc for the EHR frames. Output lands in
 * docs/screenshots/ (committed to the repo).
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const BASE = process.env.BASE_URL || 'http://localhost:3000/cms-0057';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots');
const VIEWPORT = { width: 1440, height: 900 };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Fail fast when the server is down.
  try {
    const probe = await fetch(BASE, { redirect: 'manual' });
    if (probe.status >= 500) throw new Error(`HTTP ${probe.status}`);
  } catch (e) {
    console.error(`Server unreachable at ${BASE} — start it first (npm run dev or npm start).`);
    console.error(String(e.message || e));
    process.exit(1);
  }

  // Deterministic baseline: snapshot rules + replayed demo traffic.
  await fetch(`${BASE}/api/demo/reset?mode=seeded`, { method: 'POST' });

  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  const shot = async (name) => {
    await page.screenshot({ path: join(OUT, name) });
    console.log('captured', name);
  };

  // 01 — landing page
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await shot('01-landing.png');

  // 02 — UM rules explorer with a code looked up
  await page.goto(`${BASE}/um`, { waitUntil: 'networkidle' });
  await page.fill('input[placeholder*="Try a code"]', '70553');
  await wait(800);
  await shot('02-um-rules-explorer.png');

  // 03 — live feed with the FHIR ↔ X12 drawer open on the seeded entry
  await page.click('button:has-text("Live Traffic Feed")');
  await wait(1200);
  await page.click('button:has-text("Show FHIR ↔ X12 translation")');
  await wait(600);
  await shot('03-um-feed-translator.png');

  // 04 — EHR CDS card (Jane Doe, 70553 preset)
  await page.goto(`${BASE}/ehr`, { waitUntil: 'networkidle' });
  await page.click('button:has-text("Sign Order")');
  await page.waitForSelector('text=Prior authorization required', { timeout: 15000 });
  // Bring the card and its DTR launch button fully into frame.
  await page.locator('button:has-text("Launch DTR SMART App")').scrollIntoViewIfNeeded();
  await wait(400);
  await shot('04-ehr-cds-card.png');

  // 05 — DTR questionnaire with CQL pre-population badges
  await page.click('button:has-text("Launch DTR SMART App")');
  await page.waitForSelector('text=Auto-populated via CQL', { timeout: 15000 });
  await wait(400);
  await shot('05-ehr-dtr.png');

  // 06 — PAS approved (fill required fields, submit, wait out the
  // simulated mainframe latency on the synchronous path)
  const attachment = join(tmpdir(), 'cms-0057-sandbox-attachment.txt');
  writeFileSync(attachment, 'History and physical — demo attachment.\n');
  for (const input of await page.locator('form input[type="file"]').all()) {
    await input.setInputFiles(attachment);
  }
  for (const area of await page.locator('form textarea').all()) {
    if (!(await area.inputValue())) {
      await area.fill('MRI brain indicated for chronic headache with new focal neurologic deficit after six weeks of conservative therapy.');
    }
  }
  await page.click('button:has-text("Submit PAS Request")');
  await page.waitForSelector('text=Prior Authorization Approved', { timeout: 20000 });
  await wait(400);
  await shot('06-ehr-pas-approved.png');

  // 07 — patient portal (Jane Doe: coverage, EOB card, token chip)
  await page.goto(`${BASE}/patient`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Prior authorization history', { timeout: 15000 });
  await wait(1200);
  await shot('07-patient-portal.png');

  // 08 — P2P exchange, all three steps rendered
  await page.goto(`${BASE}/um`, { waitUntil: 'networkidle' });
  await page.click('button:has-text("P2P Exchange")');
  await page.click('button:has-text("Request prior plan data")');
  await page.waitForSelector('text=Step 3', { timeout: 15000 });
  await wait(600);
  await shot('08-p2p-exchange.png');

  // 09 — provider access panel with an expanded patient
  await page.click('button:has-text("Provider Access")');
  await wait(400);
  await page.click('button:has-text("Retrieve panel")');
  await page.waitForSelector('text=attributed patient', { timeout: 15000 });
  await page.click('button:has-text("Jane Doe")');
  await wait(500);
  await shot('09-provider-access.png');

  await browser.close();
  console.log(`done — ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
