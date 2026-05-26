# CMS-0057-F Dual-Window Interoperability Simulator

A local Next.js 14 sandbox for the Da Vinci burden-reduction workflow
(CRD → DTR → PAS → adjudication). Two surfaces — a Provider EHR at
`/ehr` and a Payer UM Dashboard at `/um` — driven against a real PA
rules index extracted from the BCBSIL 2026 PA grid PDFs.

---

## 60-second how-to

```powershell
# One-time setup
npm install
python -m pip install pdfplumber   # only needed if you'll upload PDFs at runtime

# Run the dev server
npm run dev
```

Open two browser windows:

- http://localhost:3000/um  — Payer UM Dashboard
- http://localhost:3000/ehr — Provider EHR

In `/um`, click **Use previously ingested rules**. ~3,154 real rules
from the BCBSIL grids load into active CRD memory. Switch to `/ehr`,
pick (or type) a code, click **Sign Order**, and walk through the card.
PA-required orders launch a DTR Questionnaire and submit a PAS Bundle;
flip back to `/um` (Live Traffic Feed tab) to see the X12 278 stream
in alongside the original FHIR Bundle.

---

## What it does

**Payer side (`/um`)**

- **Rules Explorer.** Search the active CRD index by code, category,
  vendor, or source PDF. Detail pane shows PA status, routing, bound
  Questionnaire/CQL, documentation requirements, formulary metadata,
  and full provenance (which PDF + page).
- **Schema Explorer.** Inspect the seven sections of the CRD data
  model: payer, plans, network tiers, service categories,
  questionnaires registry, gold-card programs, and rules.
- **Rule Management Pipeline.** Upload a PA grid PDF and the server
  spawns `pdfplumber` to extract the rule table for real. The Staging
  Review shows a diff against the active index, per-source summary,
  routing distribution, and a quality gate before commit. Commit
  upserts into both runtime memory and the on-disk canonical snapshot.
- **Live Traffic Feed.** Streams every CRD evaluation, X12
  request/response, coverage-information action, and state commit.
  Includes an inline 3-column drawer that shows the FHIR Bundle and
  parallel X12 278 with field-to-segment mappings.

**Provider side (`/ehr`)**

- Curated preset orders plus a free-text input for any CPT/HCPCS/J-code.
- Renders all four CDS Hooks 2.0 indicators (info / warning / critical /
  hard-stop) with conformant styling, surfaces the `source` block, and
  promotes the SMART app link to a primary CTA.
- DTR pane fetches the bound Questionnaire dynamically and renders
  `item[]` from the FHIR R4 resource. Submission builds a real
  `QuestionnaireResponse`.
- PAS submission posts a FHIR `Bundle` containing Patient + Coverage +
  Practitioner + Claim + QuestionnaireResponse.

**Gateway behavior**

- CRD cascade: gold-card check → code-match → category-match →
  service-category default → null-rule fallback. Conditional routing
  for oncology biologics (Carelon if oncology Dx present, BCBSIL
  otherwise).
- PAS: the Bundle is **preserved unaltered** as the source of truth;
  the X12 278 is generated as a parallel projection for the legacy
  adjudication engine. ISA/GS envelope routes to the rule's
  `managed_by` vendor (BCBSIL / Carelon / Lucet / EviCore).
- `coverage-information` system action emitted on both CRD and PAS
  responses, carrying machine-readable PA determination per the
  Da Vinci CRD STU 2.2.1 extension URLs.

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
    logs/                            Poll the transaction log
    logs/clear/                      Clear feed without touching rules
data/
  preIngestedRules.json              Canonical snapshot (~3,154 rules)
  questionnaires/*.json              FHIR R4 Questionnaires
  cql/*.cql                          CQL libraries
lib/
  db.js                              File-backed JSON store (seven sections)
scripts/
  extractPreIngested.py              Offline / live PDF → rules extractor
```

---

## Demo paths worth trying

After loading the pre-ingested snapshot, on `/ehr`:

- `99214` Office Visit → no rule on the PA list → `info` card.
- `70553` MRI Brain → `warning` indicator, routed to **Carelon**.
- `J9035` Avastin with oncology Dx → `critical`, conditionally routed
  to **Carelon**; with no oncology Dx, same code routes to **BCBSIL**.
- `15820` Blepharoplasty → `critical` (functional-impairment docs),
  routed to **BCBSIL**.
- BH category-only order → exercises Pass-2 (category) matching, BH
  routing to **Lucet**.
- Toggle the **hard-stop** debug checkbox → non-overridable indicator,
  order-sign disabled per the CDS 2.0 spec.
- Type a code that isn't on any grid → fallback warning. The same code
  searched in the `/um` Rules Explorer says *"No rule matches; CRD
  engine would return a fallback warning."*

After signing a PA-required order and submitting PAS, flip to `/um`'s
**Live Traffic Feed** tab and expand the `X12 278 REQUEST` log line to
see the FHIR ↔ X12 translation drawer.

---

## Honest framing

- The simulator does **not** execute CQL; DTR pre-population values are
  hardcoded to match what each library's `define` block would compute
  against the seed Patient.
- SMART app launch is an in-page transition, not a real OAuth flow.
- The X12 278 is screen-fitting and illustrative — not TR3 005010X217
  conformant. Receiver IDs (`BCBSIL00001`, `CARELON0001`, etc.) are
  realistic-looking placeholders.
- Behavioral Health rules are overridden to `managed_by: "Lucet"`
  because the BCBSIL BH grid shows BCBSIL as the contact but Lucet is
  the actual BH UM vendor.
- Pre-ingested data was extracted with `pdfplumber` from the real
  BCBSIL 2026 PA grid PDFs; runtime uploads call the same extractor
  via the `/api/extract` endpoint.

---

## Regenerating the pre-ingested snapshot

The snapshot at `data/preIngestedRules.json` is committed to the repo so
the demo runs without Python. To re-extract from updated source PDFs:

```powershell
python scripts/extractPreIngested.py ma       <path>/2026-ma-pa-codelist-q2.pdf                          /tmp/ma.json
python scripts/extractPreIngested.py medsurg  <path>/2026-commercial-med-surg-pa-code-list.pdf           /tmp/medsurg.json
python scripts/extractPreIngested.py pharm    <path>/2026-commercial-specialty-pharmacy-pa-code-list.pdf /tmp/pharm.json
python scripts/extractPreIngested.py bh       <path>/2026-commercial-bh-pa-code-list.pdf                 /tmp/bh.json
# Then merge the four JSONs into data/preIngestedRules.json.
```

Live runtime uploads call this same script automatically via
`/api/extract`.
