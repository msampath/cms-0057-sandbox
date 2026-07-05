# CMS-0057-F Interoperability Simulator

This is a local Next.js 14 sandbox that walks through the Da Vinci burden-reduction workflow from coverage requirements discovery through prior authorization submission and adjudication, and also demonstrates the three access APIs that CMS-0057-F adds alongside the PA flow. It uses real PA rules extracted from the BCBSIL 2026 prior authorization grid PDFs. There are three browser surfaces: a provider EHR at `/ehr`, a payer UM dashboard at `/um`, and a patient access portal at `/patient`. The approximately 3,154 rules that drive the matching engine come from the actual Blue Cross Blue Shield of Illinois 2026 PA code lists rather than synthetic data.

All four APIs required by 45 CFR 156.221 are represented:

| CFR cite | API | Surface |
|---|---|---|
| 156.221(d) | Prior Authorization API (CRD → DTR → PAS) | `/ehr` + `/um` Live Traffic Feed |
| 156.221(b) | Provider Access API | `/um` Provider Access tab |
| 156.221(a) | Patient Access API | `/patient` |
| 156.221(c) | Payer-to-Payer API | `/um` P2P Exchange tab |

---

## Setup

```powershell
npm install
python -m pip install pdfplumber   # only needed if uploading PDFs at runtime
npm run dev
```

Open `/um`, `/ehr`, and `/patient` in browser windows. In `/um`, click **Use previously ingested rules** to load the full rule index into active CRD memory. From there, you can work through the EHR, patient portal, and the two new UM tabs independently.

---

## What the simulator covers

### Payer side (`/um`)

The payer dashboard has four tabs.

**Rules and Schema** contains the Rules Explorer and Schema Explorer. The Rules Explorer lets you search the active CRD index by code, category, vendor, or source PDF, and the detail pane shows PA status, routing, the bound questionnaire and CQL library, documentation requirements, formulary metadata, and the full provenance trail back to the specific PDF and page number. The Schema Explorer exposes the seven sections of the CRD data model: payer, plans, network tiers, service categories, questionnaires registry, gold-card programs, and rules. The Rule Management Pipeline accepts a PA grid PDF upload, spawns `pdfplumber` to extract the rule table from the actual document, and surfaces a diff against the active index with a per-source summary, routing distribution, and a quality gate before any commit.

**Live Traffic Feed** streams every CRD evaluation, X12 request and response, coverage-information action, and state commit, and includes an inline three-column drawer showing the FHIR bundle and the parallel X12 278 with field-to-segment mappings. Log entries now carry `npi` and `patientId` metadata on all CRD and PAS events, including `COVERAGE-INFORMATION ACTION` entries.

**Provider Access** simulates 45 CFR 156.221(b). A UM user selects a provider NPI from the dropdown and clicks "Retrieve panel." The panel queries `GET /api/provider-access?npi={npi}`, which reads the in-memory transaction log and returns all attributed patients along with their event history. Each patient row is expandable to show the full event log for that provider-patient pair. A banner in the panel describes the SMART on FHIR v2 backend-services scopes that a production endpoint would require (`system/Patient.read`, `system/ExplanationOfBenefit.read`, `system/ClaimResponse.read`).

**P2P Exchange** simulates 45 CFR 156.221(c). A UM user selects a newly enrolled member and clicks "Request prior plan data." The panel:
- Sends `POST /api/payer-to-payer/member-match` with a FHIR Parameters body containing `MemberPatient` and `CoverageToMatch` resources
- Shows the matched response (Step 2)
- Fetches `GET /api/payer-to-payer/history/{patientId}` for the prior plan PA history and EOB summary (Step 3)

Each step is displayed as a collapsible JSON block as it completes.

### Provider side (`/ehr`)

The EHR surface is built around four patient scenarios, each carrying its own demographics, plan type, ordering practitioner NPI, and a suggested default order. Switching scenarios resets the form and re-runs matching against the correct plan-specific rule set.

| Scenario | Plan | What it shows |
|---|---|---|
| Jane Doe | COMM-PPO | Baseline: MRI Brain with Carelon routing, full DTR and PAS arc |
| Robert Chen | MA-PPO | Same code (70553), filtered to MA-specific rules only |
| Dorothy Hayes | COMM-PPO | Dr. Patel on the Orthopedic Gold Card: TKA auto-satisfied, no documentation required |
| Marcus Johnson | COMM-HMO | ABA category match routed to Lucet, autism diagnosis pre-loaded |

Beyond the presets there is a free-text input that accepts any CPT, HCPCS, or J-code. The surface renders all four CDS Hooks 2.0 indicators (info, warning, critical, and hard-stop) with conformant styling, surfaces the `source` block, and promotes the SMART app link as the primary action. The DTR pane fetches the bound questionnaire dynamically and renders `item[]` from the FHIR R4 resource. PAS submission posts a FHIR `Bundle` containing Patient, Coverage, Practitioner, Claim, and QuestionnaireResponse.

### Patient side (`/patient`)

The patient access portal simulates 45 CFR 156.221(a). A patient selects their name from the buttons at the top (simulating a payer portal login), and the surface polls `GET /api/patient-access?patientId={id}` every three seconds via SWR.

The left column shows a coverage card (plan name, type, payer, member ID, coverage ID, benefit year) and the SMART on FHIR v2 scopes that a production app would need (`patient/Patient.read`, `patient/Coverage.read`, `patient/ExplanationOfBenefit.read`, `patient/ClaimResponse.read`). The right column shows the full PA history from the transaction log for that patient, color-coded by event type (hook received, evaluation, pended, approved, denied, coverage-information action, FHIR response). Switching patients re-fetches immediately.

### Matching and routing

The CRD cascade runs in this order: gold-card exemption check → exact code match → category substring match → service-category default rule → null-rule fallback. Rules are pre-filtered to the patient's plan before matching begins. Pre-ingested rules carry a `source_label` of Medicare Advantage, Commercial Med-Surg, Behavioral Health, or Specialty Pharmacy, and behavioral health and pharmacy rules apply across all plans. NPI `GOLD-NPI-0001` is enrolled in the Orthopedic Gold Card program, so ordering 27447 as Dr. Patel auto-satisfies PA while the same code from any other NPI follows the normal path. Oncology biologic routing is conditional: Carelon if an oncology ICD-10 condition in the C00-D49 range is present, BCBSIL otherwise, and that logic is shared between the CRD and PAS endpoints via `lib/routing.js`. On the PAS side the FHIR bundle is preserved unaltered as the source of truth and the X12 278 is generated as a parallel projection. A `coverage-information` system action is emitted on both CRD and PAS responses, carrying the machine-readable PA determination per the Da Vinci CRD STU 2.2.1 extension URLs.

---

## Where things live

```
app/
  ehr/page.jsx                              Provider EHR + DTR SMART surface
  patient/page.jsx                          Patient Access Portal
  um/page.jsx                               Payer UM Dashboard (four tabs)
  um/rulesExplorer.jsx                      Rules Explorer panel
  um/schemaExplorer.jsx                     Schema Explorer panel
  um/translatorDrawer.jsx                   FHIR ↔ X12 inline drawer
  um/providerAccess.jsx                     Provider Access tab panel
  um/p2pExchange.jsx                        P2P Exchange tab panel
  um/stagingData.js                         Pattern matchers + staging helpers
  api/
    cds-services/order-sign/               CRD engine (CDS Hooks 2.0)
    pas/submit/                            PAS endpoint + X12 generator
    pas/pended/[id]/                       Polling endpoint for pended PA requests
    pas/x12Generator.js                    FHIR Bundle → X12 278 + mappings
    provider-access/                       Provider Access API (45 CFR 156.221(b))
    patient-access/                        Patient Access API (45 CFR 156.221(a))
    payer-to-payer/member-match/           PDex $member-match endpoint
    payer-to-payer/history/[patientId]/    Prior plan history endpoint
    extract/                               Live PDF extraction (spawns pdfplumber)
    rules/                                 GET active rules
    rules/load-pre-ingested/               Load the snapshot into active memory
    schema/                                GET the seven schema sections
    questionnaire/[id]/                    Serve DTR Questionnaire JSON
    cql/[id]/                              Serve CQL Library
    commit-rules/                          Upsert staged rules into runtime + snapshot
    logs/                                  Poll the in-memory transaction log
    logs/clear/                            Clear feed without touching rules
data/
  preIngestedRules.json                    Canonical snapshot (~3,154 rules)
  questionnaires/*.json                    FHIR R4 Questionnaires
  cql/*.cql                                CQL libraries
lib/
  db.js                                    File-backed JSON store (seven sections);
                                           module-level rule cache; in-memory tx log;
                                           PRIOR_PLAN_HISTORY seed constant
  routing.js                               Shared oncology vendor-routing logic
scripts/
  extractPreIngested.py                    Offline / live PDF → rules extractor
```

---

## Suggested walkthrough

Load the pre-ingested snapshot from `/um` first, then work through these scenarios.

### Prior Authorization API walkthrough (`/ehr` + `/um`)

**Jane Doe (COMM-PPO)** is the baseline scenario. `99214` returns an info card because the code is not on the PA list. `70553` (MRI Brain) returns a warning indicator and routes to Carelon. `J9035` (Avastin) with the oncology diagnosis preset returns a critical indicator also routed to Carelon. Switching to the no-oncology-diagnosis variant keeps the same code but re-routes to BCBSIL, which is the conditional routing logic in `lib/routing.js`. Toggling hard-stop produces a non-overridable indicator and disables the order-sign button.

For the pended PA path, select `15820` (Blepharoplasty), complete the DTR questionnaire, and submit PAS. The EHR shows an amber pending state immediately. After eight seconds the server finalizes, fires a simulated REST-hook notification, and the EHR polls and switches to a green approved state. The `/um` Live Traffic Feed shows the full sequence: BUNDLE RECEIVED → PA PENDED → PA APPROVED (pended → finalized) → REST-HOOK NOTIFICATION.

For the denial path, check **simulate denial** in Order Entry before submitting any PA-required order. The ClaimResponse returns `outcome: error` with a Da Vinci PAS `reviewAction.actionCode: deny` and X12 AAA reason code `A4`.

**Robert Chen (MA-PPO)** demonstrates plan-type filtering. The same `70553` order now matches against MA-specific rules only.

**Dorothy Hayes (COMM-PPO + Gold Card)** has `27447` (TKA) pre-filled. Signing the order auto-satisfies PA for Dr. Patel because NPI `GOLD-NPI-0001` is enrolled in the Orthopedic Gold Card program.

**Marcus Johnson (COMM-HMO)** has an ABA order with `F84.0` pre-loaded and demonstrates category-level matching routed to Lucet.

### Provider Access walkthrough (`/um` Provider Access tab)

After running at least one order from `/ehr`, switch to `/um` and click **Provider Access**. Select **Ada Smith — NPI 1234567890** (the NPI attached to Jane Doe, Robert Chen, and Marcus Johnson's scenarios) and click **Retrieve panel**. The panel returns a row for each patient that has a transaction log entry attributed to that NPI. Expanding a patient row shows the full event log for that provider-patient pair, including every CRD evaluation and coverage-information action. Dr. Patel's NPI (`GOLD-NPI-0001`) is attributed to Dorothy Hayes scenarios.

### Patient Access walkthrough (`/patient`)

Open `/patient` in a browser window while also running orders from `/ehr`. Select Jane Doe and the coverage card loads immediately with her plan details and member ID. The PA history section on the right updates every three seconds as CRD and PAS events arrive. Selecting a different patient re-fetches the coverage and history for that member immediately. The SMART scopes card on the left describes the authorization a real third-party health app would need to access this data.

### P2P Exchange walkthrough (`/um` P2P Exchange tab)

Click **P2P Exchange** in `/um`. Select Jane Doe from the dropdown and click **Request prior plan data**. Step 1 displays the `POST /Patient/$member-match` Parameters body being sent to the prior payer (Aetna). Step 2 shows the matched response with Aetna's member identifier. Step 3 shows the prior PA history (including a denied authorization) and EOB summary retrieved from Aetna's record. Switching to Marcus Johnson and requesting again shows a different prior payer (Cigna) and a different PA history.

---

## Sandbox boundaries

Authentication is simulated throughout. The Provider Access and Patient Access APIs return data based on query parameters (NPI or patient ID) without any real SMART on FHIR token validation. In production, both would require a signed JWT verified against a registered JWKS endpoint.

CQL is not executed; DTR pre-population values are hardcoded to match what each library's `define` block would compute against the seed patient. SMART app launch is an in-page transition rather than a real OAuth flow.

The X12 278 is illustrative and not TR3 005010X217 conformant; receiver IDs like `BCBSIL00001` and `CARELON0001` are realistic-looking placeholders.

Behavioral health rules are overridden to `managed_by: "Lucet"` because the BCBSIL BH grid lists BCBSIL as the contact but Lucet is the actual BH utilization management vendor.

The transaction log and the pending PA request map are both in-memory only and reset on server restart. `database.json` stores committed rules and schema. The live feed is ephemeral by design.

The prior plan data in the P2P Exchange tab (prior payer names, prior PA history, EOB summaries) is seeded in `PRIOR_PLAN_HISTORY` in `lib/db.js` and does not reflect real claims.

---

## Regenerating the pre-ingested snapshot

The snapshot at `data/preIngestedRules.json` is committed to the repo so the demo runs without Python. To re-extract from updated source PDFs, run each extractor against the corresponding file and then merge the four output JSONs into `data/preIngestedRules.json`.

```powershell
python scripts/extractPreIngested.py ma       <path>/2026-ma-pa-codelist-q2.pdf                          /tmp/ma.json
python scripts/extractPreIngested.py medsurg  <path>/2026-commercial-med-surg-pa-code-list.pdf           /tmp/medsurg.json
python scripts/extractPreIngested.py pharm    <path>/2026-commercial-specialty-pharmacy-pa-code-list.pdf /tmp/pharm.json
python scripts/extractPreIngested.py bh       <path>/2026-commercial-bh-pa-code-list.pdf                 /tmp/bh.json
```
