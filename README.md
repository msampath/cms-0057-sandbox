# CMS-0057-F Interoperability Simulator

This is a local Next.js 14 sandbox that walks through the Da Vinci burden-reduction workflow from coverage requirements discovery through prior authorization submission and adjudication, using real PA rules extracted from the BCBSIL 2026 prior authorization grid PDFs. There are two browser surfaces: a provider EHR at `/ehr` and a payer UM dashboard at `/um`, and the approximately 3,154 rules that drive the matching engine come from the actual Blue Cross Blue Shield of Illinois 2026 PA code lists rather than synthetic data.

---

## Setup

```powershell
npm install
python -m pip install pdfplumber   # only needed if uploading PDFs at runtime
npm run dev
```

Open `/um` and `/ehr` in two browser windows. In `/um`, click **Use previously ingested rules** to load the full rule index into active CRD memory, then switch to `/ehr`, select a patient scenario, and sign an order. PA-required orders launch a DTR questionnaire and submit a PAS bundle; switching back to `/um` and opening the Live Traffic Feed tab shows the X12 278 alongside the original FHIR bundle.

---

## What the simulator covers

**Payer side (`/um`)**

The payer dashboard has four main areas. The Rules Explorer lets you search the active CRD index by code, category, vendor, or source PDF, and the detail pane shows PA status, routing, the bound questionnaire and CQL library, documentation requirements, formulary metadata, and the full provenance trail back to the specific PDF and page number. The Schema Explorer exposes the seven sections of the CRD data model: payer, plans, network tiers, service categories, questionnaires registry, gold-card programs, and rules. The Rule Management Pipeline accepts a PA grid PDF upload, spawns `pdfplumber` to extract the rule table from the actual document, and surfaces a diff against the active index with a per-source summary, routing distribution, and a quality gate before any commit; a commit upserts into both runtime memory and the on-disk canonical snapshot. The Live Traffic Feed streams every CRD evaluation, X12 request and response, coverage-information action, and state commit, and includes an inline three-column drawer showing the FHIR bundle and the parallel X12 278 with field-to-segment mappings.

**Provider side (`/ehr`)**

The EHR surface is built around four patient scenarios, each carrying its own demographics, plan type, ordering practitioner NPI, and a suggested default order. Switching scenarios resets the form and re-runs matching against the correct plan-specific rule set.

| Scenario | Plan | What it shows |
|---|---|---|
| Jane Doe | COMM-PPO | Baseline: MRI Brain with Carelon routing, full DTR and PAS arc |
| Robert Chen | MA-PPO | Same code (70553), filtered to MA-specific rules only |
| Dorothy Hayes | COMM-PPO | Dr. Patel on the Orthopedic Gold Card: TKA auto-satisfied, no documentation required |
| Marcus Johnson | COMM-HMO | ABA category match routed to Lucet, autism diagnosis pre-loaded |

Beyond the presets there is a free-text input that accepts any CPT, HCPCS, or J-code. The surface renders all four CDS Hooks 2.0 indicators (info, warning, critical, and hard-stop) with conformant styling, surfaces the `source` block, and promotes the SMART app link as the primary action. The DTR pane fetches the bound questionnaire dynamically and renders `item[]` from the FHIR R4 resource; submission produces a real `QuestionnaireResponse`. PAS submission posts a FHIR `Bundle` containing Patient, Coverage, Practitioner, Claim, and QuestionnaireResponse.

**Matching and routing**

The CRD cascade runs in this order: gold-card exemption check → exact code match → category substring match → service-category default rule → null-rule fallback. Rules are pre-filtered to the patient's plan before matching begins; pre-ingested rules carry a `source_label` of Medicare Advantage, Commercial Med-Surg, Behavioral Health, or Specialty Pharmacy, and behavioral health and pharmacy rules apply across all plans. NPI `GOLD-NPI-0001` is enrolled in the Orthopedic Gold Card program, so ordering 27447 as Dr. Patel auto-satisfies PA while the same code from any other NPI follows the normal path. Oncology biologic routing is conditional: Carelon if an oncology ICD-10 condition in the C00-D49 range is present, BCBSIL otherwise, and that logic is shared between the CRD and PAS endpoints via `lib/routing.js`. On the PAS side the FHIR bundle is preserved unaltered as the source of truth and the X12 278 is generated as a parallel projection, with the ISA/GS envelope routing to the rule's `managed_by` vendor. A `coverage-information` system action is emitted on both CRD and PAS responses, carrying the machine-readable PA determination per the Da Vinci CRD STU 2.2.1 extension URLs.

---

## Where things live

```
app/
  ehr/page.jsx                       Provider EHR + DTR SMART surface
  um/page.jsx                        Payer UM Dashboard (tabbed)
  um/rulesExplorer.jsx               Rules Explorer panel
  um/schemaExplorer.jsx              Schema Explorer panel (7 sections)
  um/translatorDrawer.jsx            FHIR ↔ X12 inline drawer
  um/stagingData.js                  Pattern matchers + staging helpers
  api/
    cds-services/order-sign/         CRD engine (CDS Hooks 2.0)
    pas/submit/                      PAS endpoint + X12 generator
    pas/x12Generator.js              FHIR Bundle → X12 278 + mappings
    extract/                         Live PDF extraction (spawns pdfplumber)
    rules/                           GET active rules
    rules/load-pre-ingested/         Load the snapshot into active memory
    schema/                          GET the seven schema sections
    questionnaire/[id]/              Serve DTR Questionnaire JSON
    cql/[id]/                        Serve CQL Library
    commit-rules/                    Upsert staged rules into runtime + snapshot
    logs/                            Poll the in-memory transaction log
    logs/clear/                      Clear feed without touching rules
data/
  preIngestedRules.json              Canonical snapshot (~3,154 rules)
  questionnaires/*.json              FHIR R4 Questionnaires
  cql/*.cql                          CQL libraries
lib/
  db.js                              File-backed JSON store (seven sections);
                                     module-level rule cache; in-memory tx log
  routing.js                         Shared oncology vendor-routing logic
scripts/
  extractPreIngested.py              Offline / live PDF → rules extractor
```

---

## Suggested walkthrough

Load the pre-ingested snapshot from `/um` first, then work through these scenarios on `/ehr`.

**Jane Doe (COMM-PPO)** is the baseline scenario and covers the most ground. `99214` returns an info card because the code does not appear on the PA list. `70553` (MRI Brain) returns a warning indicator and routes to Carelon. `J9035` (Avastin) with the oncology diagnosis preset returns a critical indicator also routed to Carelon; switching to the no-oncology-diagnosis variant keeps the same code and the same rule but re-routes to BCBSIL instead, which is the conditional routing logic in `lib/routing.js` at work. `15820` (Blepharoplasty) returns a critical indicator with functional-impairment documentation requirements. Toggling hard-stop produces a non-overridable indicator and disables the order-sign button.

**Robert Chen (MA-PPO)** demonstrates plan-type filtering. The same `70553` order now matches against MA-specific rules only, and the card source references the MA PA grid PDF rather than the commercial one.

**Dorothy Hayes (COMM-PPO + Gold Card)** has `27447` (TKA) pre-filled. Signing the order auto-satisfies PA for Dr. Patel because NPI `GOLD-NPI-0001` is enrolled in the Orthopedic Gold Card program, so no DTR questionnaire appears and no PAS bundle is submitted. Switching to Jane Doe and entering the same code shows the normal PA path for an NPI that is not on the gold card.

**Marcus Johnson (COMM-HMO)** has an ABA order with `F84.0` pre-loaded, and this is the scenario that shows category-level matching rather than code-level matching, routed to Lucet.

After any PA-required order and PAS submission, opening the Live Traffic Feed in `/um` and expanding the X12 278 REQUEST entry shows the FHIR-to-X12 translation drawer with field-to-segment mappings across three columns.

---

## Sandbox boundaries

CQL is not executed; DTR pre-population values are hardcoded to match what each library's `define` block would compute against the seed patient. SMART app launch is an in-page transition rather than a real OAuth flow. The X12 278 is illustrative and not TR3 005010X217 conformant; receiver IDs like `BCBSIL00001` and `CARELON0001` are realistic-looking placeholders. Behavioral health rules are overridden to `managed_by: "Lucet"` because the BCBSIL BH grid lists BCBSIL as the contact but Lucet is the actual BH utilization management vendor. Pre-ingested data was extracted with `pdfplumber` from the real BCBSIL 2026 PA grid PDFs, and runtime uploads call the same extractor via `/api/extract`. The transaction log is in-memory only and resets on server restart; `database.json` stores committed rules and schema, and the live feed is ephemeral by design.

---

## Regenerating the pre-ingested snapshot

The snapshot at `data/preIngestedRules.json` is committed to the repo so the demo runs without Python. To re-extract from updated source PDFs, run each extractor against the corresponding file and then merge the four output JSONs into `data/preIngestedRules.json`.

```powershell
python scripts/extractPreIngested.py ma       <path>/2026-ma-pa-codelist-q2.pdf                          /tmp/ma.json
python scripts/extractPreIngested.py medsurg  <path>/2026-commercial-med-surg-pa-code-list.pdf           /tmp/medsurg.json
python scripts/extractPreIngested.py pharm    <path>/2026-commercial-specialty-pharmacy-pa-code-list.pdf /tmp/pharm.json
python scripts/extractPreIngested.py bh       <path>/2026-commercial-bh-pa-code-list.pdf                 /tmp/bh.json
```
