# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

A local Next.js 14 sandbox simulating the **Da Vinci burden-reduction workflow** (CRD → DTR → PAS → adjudication) for healthcare provider-payer interoperability, using real BCBSIL 2026 PA grid data (~3,154 rules). It has three browser surfaces:
- `/ehr` — Provider EHR + DTR SMART surface (order picker, CDS card, questionnaire, PAS submit)
- `/um` — Payer UM Dashboard (rules explorer, schema browser, live traffic feed, PDF ingestion pipeline, Provider Access tab, P2P Exchange tab)
- `/patient` — Patient Access Portal (coverage card, PA history, SMART scopes display)

**All four CMS-0057-F mandated FHIR APIs are now implemented:**
- PA API (45 CFR 156.221(d)) — CRD → DTR → PAS flow; implemented in earlier sessions
- Provider Access API (45 CFR 156.221(b)) — `GET /api/provider-access?npi={npi}`; Provider Access tab in `/um`
- Patient Access API (45 CFR 156.221(a)) — `GET /api/patient-access?patientId={id}`; `/patient` surface
- Payer-to-Payer API (45 CFR 156.221(c)) — `POST /api/payer-to-payer/member-match` + `GET /api/payer-to-payer/history/[patientId]`; P2P Exchange tab in `/um`

## Commands

```powershell
npm run dev      # Start dev server at http://localhost:3000
npm run build    # Production build
npm run lint     # ESLint (next/core-web-vitals)
```

No test suite exists. Lint is the only automated check.

**Python setup** (optional — only needed for runtime PDF uploads; pre-ingested rules ship in `data/preIngestedRules.json`):
```powershell
python -m pip install pdfplumber
```

**Path alias**: `@/*` resolves to the repo root (configured in `jsconfig.json`).

## Architecture

### Data Layer (`lib/db.js`)

File-backed JSON store (`database.json`, git-ignored). Seven named sections persisted together:

| Section | Purpose |
|---|---|
| `payer` | BCBSIL org identity |
| `plans` | COMM-PPO, COMM-HMO, MA-PPO with PA defaults |
| `network_tiers` | Centers of Excellence vs Standard Network |
| `service_categories` | Advanced Imaging, Specialty Pharmacy, Behavioral Health default rules |
| `rules` | Per (plan_type + service_code) PA determinations — the live rule index |
| `questionnaires` | Registry of DTR Questionnaire canonical URLs |
| `gold_card_programs` | Provider-level PA exemptions |

Plus an in-memory `transactionLog` (CRD/PAS/commit events streamed to `/um` Live Feed) and a module-level `PRIOR_PLAN_HISTORY` constant with seed prior-plan data for all four demo patients (prior payer, prior plan ID, prior PAs, EOB summaries).

### CDS Hooks Engine (`app/api/cds-services/order-sign/`)

The core gateway. Called on every EHR order. Cascade matching order:
1. Gold-card exemption check
2. Exact code match (e.g., `70553`)
3. Category substring match (e.g., "Advanced Imaging")
4. `service_categories` default rule
5. Plan-level PA default

**Vendor routing**: BCBSIL by default; oncology biologics (J9035 + C/D0-49 diagnosis codes) → Carelon; behavioral health → Lucet; imaging fallback → EviCore.

Returns CDS Hooks 2.0 cards (info/warning/critical/hard-stop) + a `coverage-information` system action per Da Vinci CRD STU 2.2.1.

Every `logTransaction` call in this route now carries `{ npi, patientId, code }` meta, including the `COVERAGE-INFORMATION ACTION` entry. This meta is what enables the Provider Access and Patient Access APIs to filter the log by NPI and patient.

### Provider Access API (`app/api/provider-access/`)

`GET /api/provider-access?npi={npi}` — reads the in-memory transaction log, filters by NPI and non-null patientId, groups by patient, and returns a panel of attributed patients with their event history. In production this would require a SMART on FHIR v2 backend-services JWT; the demo accepts the NPI as a query parameter. Required scopes: `system/Patient.read`, `system/ExplanationOfBenefit.read`, `system/ClaimResponse.read`.

### Patient Access API (`app/api/patient-access/`)

`GET /api/patient-access?patientId={id}` — returns a FHIR-shaped Patient resource, a Coverage resource, SMART scopes, and all transaction log events for that patient. The `/patient` surface polls this every 3 seconds via SWR. Required scopes: `patient/Patient.read`, `patient/Coverage.read`, `patient/ExplanationOfBenefit.read`, `patient/ClaimResponse.read`.

### Payer-to-Payer API (`app/api/payer-to-payer/`)

Two endpoints together simulate the Da Vinci PDex `$member-match` + bulk history exchange:
- `POST /api/payer-to-payer/member-match` — accepts a FHIR Parameters body (`MemberPatient` + `CoverageToMatch`); matches by `subscriberId` first, then by patient ID; returns a Parameters response with `MemberIdentifier` and `_matchedPatientId` (a demo convenience field).
- `GET /api/payer-to-payer/history/[patientId]` — returns the `PRIOR_PLAN_HISTORY` seed block for the matched patient (prior payer, plan, disenrollment date, prior PAs, EOB summary).

The P2P Exchange tab in `/um` drives both calls sequentially and displays each step as it completes.

### FHIR ↔ X12 Duality (`app/api/pas/`, `app/api/pas/x12Generator.js`)

PAS endpoint receives a FHIR Bundle (Patient + Coverage + Practitioner + Claim + QuestionnaireResponse). The FHIR Bundle is kept as the source of truth; an X12 278 is generated in parallel as a projection for legacy adjudication. The `/um` translator drawer makes the field-to-segment mappings inspectable in real time.

### Rule Ingestion Pipeline (`app/api/extract/`, `app/api/commit-rules/`, `scripts/extractPreIngested.py`)

1. Upload PA grid PDF via `/um` UI
2. `app/api/extract/` spawns `scripts/extractPreIngested.py` (pdfplumber, word-position grouping)
3. Extracted rules staged in memory; diff surfaced in UM dashboard
4. Quality gate → commit upserts staged rules into `rules` section and writes snapshot to disk

**Pre-ingested snapshot**: `data/preIngestedRules.json` loads via `app/api/rules/load-pre-ingested/` so the demo works without Python.

### Key Files

- `lib/db.js` — All persistence; understand this first before touching data-related routes. Also contains `PRIOR_PLAN_HISTORY` (seed prior-plan data) and the `logTransaction(actor, action, details, meta={})` signature where `meta` is spread into the log entry.
- `app/api/cds-services/order-sign/route.js` — CRD matching engine; logs NPI and patientId on every call
- `app/api/pas/x12Generator.js` — FHIR → X12 278 mapping
- `app/api/provider-access/route.js` — Provider Access API; contains its own `PATIENT_META` map
- `app/api/patient-access/route.js` — Patient Access API; contains its own extended `PATIENT_META` map
- `app/api/payer-to-payer/member-match/route.js` — PDex $member-match simulation
- `app/api/payer-to-payer/history/[patientId]/route.js` — Prior plan history endpoint
- `app/um/providerAccess.jsx` — Provider Access panel (NPI lookup, patient panel, event log)
- `app/um/p2pExchange.jsx` — P2P Exchange panel (3-step member-match + history flow)
- `app/patient/page.jsx` — Patient Access Portal surface
- `app/um/stagingData.js` — PDF pattern matchers and staging helpers
- `data/preIngestedRules.json` — Canonical 3,154-rule snapshot (committed, re-generated by `scripts/generatePreIngested.mjs`)

**Known structural debt**: patient demographics (name, DOB, plan type, subscriber ID) are duplicated across `app/ehr/page.jsx` (`PATIENT_SCENARIOS`), `app/api/provider-access/route.js` (`PATIENT_META`), `app/api/patient-access/route.js` (`PATIENT_META`), `app/patient/page.jsx` (`PATIENTS`), and `app/um/p2pExchange.jsx` (`PATIENTS`). A future refactor could consolidate these into a single `lib/patients.js` module.

### Static Assets

- `data/questionnaires/` — 7 FHIR R4 Questionnaire templates (served by `app/api/questionnaire/[id]/`)
- `data/cql/` — 6 CQL library stubs for DTR pre-population (served by `app/api/cql/[id]/`)

## Current Status

All four CMS-0057-F mandated FHIR APIs are implemented. The research plan that guided this work is in `provider-patient-p2p-research.md` at the repo root; it is complete and kept for reference.

The implementation passed a 25-test Playwright QA run and a multi-angle code review. Eight bugs were fixed in the code review pass:
- `histRes.ok` not checked in `p2pExchange.jsx` before reading history data
- `COVERAGE-INFORMATION ACTION` log calls in `order-sign` and `pas/submit` missing `npi`/`patientId` meta
- REST-HOOK NOTIFICATION in the `setTimeout` closure missing `patientId` meta
- Duplicate `X12 278 REQUEST` log entry in the denial simulation path
- `addPendingRequest` passing `patientId: undefined` instead of `'unknown'` when patient is null
- Unused `patient` variable in `app/patient/page.jsx`

## Next Steps

Potential next build chunks, roughly in priority order:

1. **Consolidate patient data** — extract `lib/patients.js` with a single source of truth for the four demo patients, replacing the five independent copies currently scattered across `ehr/page.jsx`, both API routes, `patient/page.jsx`, and `p2pExchange.jsx`. Low risk, high maintainability payoff.

2. **CARIN Blue Button EOB resources** — the Patient Access API currently returns Coverage and ClaimResponse. The CMS Patient Access final rule references CARIN IG for Blue Button (BB2.0) as the claims data profile. Adding an `ExplanationOfBenefit` resource shaped to CARIN BB2.0 would make the demo more accurate to what a production patient-facing endpoint returns.

3. **PDex $member-match conformance** — the current P2P implementation uses a `_matchedPatientId` convenience field outside the spec-defined Parameters response. A more conformant path parses `MemberIdentifier.valueIdentifier.value` from the returned Parameters and uses that to build the history fetch URL.

4. **Real SMART on FHIR simulation** — the three new APIs declare their required scopes in the response but do not enforce them. A lightweight simulated token endpoint (issuing a short-lived demo JWT) would let the demo show the actual SMART backend-services and patient-launch flows end to end, without the real OAuth dependency.

5. **Log persistence across restarts** — the transaction log is in-memory and resets on `npm run dev` restart. Writing it to `database.json` alongside the rules (with a configurable max-size trim) would let the live feed and provider/patient access panels show data from a previous session.

## Writing and Documentation Voice

Any README edits, architecture docs, comments written in the user's voice, or other user-facing prose must follow the voice fingerprint at:

```
C:\Users\Admin\OneDrive\Desktop\surakshith-voice-fingerprint.md
```

Read that file before writing anything in the user's name. The short rules that matter most for this repo, which may override the voice fingerprint:

- No contractions, no em-dashes, no semicolons, no exclamation marks
- Bullets for technical writing - split long, multi-clause sentences into individual bullets. Tighten for brevity and clarity, not for punchiness or impact
- In technical writing, use `→` for process flows, not comma-separated prose runs
- No AI-tells: no "honest framing", no dramatic colon setups, no short punchy declaratives for effect
- Hedge claims; lead from experience; do not make universal pronouncements
