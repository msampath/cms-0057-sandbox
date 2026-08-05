# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

A Next.js 14 sandbox simulating the **Da Vinci burden-reduction workflow** (CRD → DTR → PAS → adjudication) for healthcare provider-payer interoperability, using real BCBSIL 2026 PA grid data (~3,154 rules). Deployed to Google Cloud Run and served at `surakshith.com/cms-0057` through a Firebase Hosting rewrite. It has three browser surfaces:
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
npm run dev          # Start dev server at http://localhost:3000/cms-0057
npm run build        # Production build
npm run lint         # ESLint (next/core-web-vitals)
npm run screenshots  # Playwright capture into docs/screenshots/ (needs a running server)
```

**Base path**: the app serves under `basePath: '/cms-0057'` everywhere (dev, Docker, prod), so the root URL intentionally 404s. Next rewrites `next/link` and static assets automatically, but **not** literal `fetch('/api/...')` calls in client components. Every client fetch must go through `apiUrl()` in `lib/basePath.js`. A missed call site 404s only in the browser, so a full click-through of all four surfaces is the test.

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

Plus an in-memory `transactionLog` (CRD/PAS/commit events streamed to `/um` Live Feed) and an in-memory pending-request map. Both reset on restart and on Cloud Run scale-to-zero, by design.

**Auto-seed**: `ensureSeeded()` runs lazily from `getDb()`, `getLog()`, **and** `logTransaction()`. The third call site matters: `order-sign` logs before it ever calls `getDb()`, so seeding from the first two alone gets skipped when a CDS hook is the first request after boot. Seeding loads the 3,154-rule snapshot and replays three demo arcs from `lib/seed.js` with back-dated timestamps, so a first-time visitor sees populated surfaces with zero clicks.

**Demo reset**: `resetDemoState(mode)` backs `POST /api/demo/reset`. `mode=seeded` restores the baseline. `mode=empty` clears everything and sets `_emptyLatch` so the lazy seed does not refill, which preserves the "start empty, ingest a PDF live" interview story.

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

`GET /api/provider-access?npi={npi}` — reads the in-memory transaction log, filters by NPI and non-null patientId, groups by patient, and returns a panel of attributed patients with their event history. Requires a Bearer token with `system/Patient.read`, `system/ExplanationOfBenefit.read`, `system/ClaimResponse.read`.

### Patient Access API (`app/api/patient-access/`)

`GET /api/patient-access?patientId={id}` — returns a US Core shaped Patient, a C4BB shaped Coverage, CARIN BB `ExplanationOfBenefit` resources from `lib/eob.js`, SMART scopes, and all transaction log events for that patient. The `/patient` surface polls this every 3 seconds via SWR. Requires a Bearer token with `patient/Patient.read`, `patient/Coverage.read`, `patient/ExplanationOfBenefit.read`, `patient/ClaimResponse.read`.

The response keeps a `{smartScopes, patient, coverage, eobs, events}` envelope rather than being a pure FHIR Bundle, because the portal needs the event stream. That trade-off is noted in `docs/conformance.md`.

### Payer-to-Payer API (`app/api/payer-to-payer/`)

Two endpoints together simulate the Da Vinci PDex `$member-match` + history exchange. Both require system scopes.
- `POST /api/payer-to-payer/member-match` — accepts a FHIR Parameters body (`MemberPatient` + `CoverageToMatch`); matches by `subscriberId` first, then by patient ID; returns a **pure Parameters response** with `MemberIdentifier`. No underscore-prefixed convenience fields. The client parses `MemberIdentifier.valueIdentifier.value` to build the history URL.
- `GET /api/payer-to-payer/history/[patientId]` — returns a **searchset Bundle**: the prior-plan Coverage (with `period.end` at disenrollment), one ClaimResponse per prior PA (`use: preauthorization`, denials carrying `reviewAction` plus `error[]`), and CARIN BB EOBs.

The P2P Exchange tab in `/um` drives both calls sequentially and walks the returned Bundle by `resourceType`.

### SMART demo auth (`lib/auth.js`, `lib/keys.js`, `app/api/auth/token/`)

The three access APIs enforce SMART-style Bearer tokens. Not real OAuth, but the request shape is right.

- `POST /api/auth/token` — `client_credentials` + `scope` → a 300-second JWT signed with node `crypto`, no new dependencies
- `authMode()` in `lib/auth.js` picks the algorithm per deployment: **RS384** when `SANDBOX_PRIVATE_KEY_B64` is set (via `lib/keys.js`), else HS256 with a demo shared secret. Read at call time, not cached at module load — do not copy the module-load caching pattern `AUTH_ENABLED` uses.
- `verifyToken()` parses the JWT header and rejects immediately on an `alg` mismatch against the active mode, before touching the signature. This is the actual defense against algorithm-confusion attacks — do not accept both algorithms at once, and do not remove the header check.
- Discovery at `app/api/.well-known/smart-configuration/`. Origin is resolved from `x-forwarded-host`/`x-forwarded-proto`, not `request.url` — Cloud Run terminates TLS externally and proxies internally, so `request.url` reflects the container's internal bind address. This bit the `jwks_uri`/`token_endpoint` fields once already; do not revert to `new URL(request.url).origin`.
- `requireScopes()` returns a 401 OperationOutcome with `WWW-Authenticate` when the token is missing, 403 when scopes are insufficient. The 401 → token → 200 sequence is a demo beat, so do not silently make these routes open
- `DEMO_AUTH=off` is the kill switch
- Client side: `lib/smartClient.js` caches a token per scope set and exposes `authedFetch()`. Unaffected by the RS384 change — it only ever handles the opaque Bearer string.
- `lib/keys.js` also backs the outbound side: `lib/epicBackend.js` signs its client assertion to Epic with the same keypair. One JWKS, two consumers.

### Pended review (`lib/pendedReview.js`)

`finalizePendedIfDue(id)` is **request-driven**, not timer-driven. Cloud Run scales to zero and does not keep `setTimeout` callbacks alive, so the client poll decides whether the 8-second `reviewWindow()` has elapsed. Do not reintroduce a timer here.

### FHIR ↔ X12 Duality (`app/api/pas/`, `app/api/pas/x12Generator.js`)

PAS endpoint receives a FHIR Bundle (Patient + Coverage + Practitioner + Claim + QuestionnaireResponse). The FHIR Bundle is kept as the source of truth, and an X12 278 is generated in parallel as a projection for legacy adjudication. The `/um` translator drawer makes the field-to-segment mappings inspectable in real time.

**Response shape**: all three return sites wrap the result via `wrapPasResponseBundle()` in `lib/fhir.js` — a `Bundle.type = 'collection'` (pinned by the PAS IG, not `transaction-response`) holding the ClaimResponse plus a coverage-information Task, each with a `urn:uuid:` fullUrl. The ClaimResponse carries `meta.profile`. The old `_routedTo` and `_wasPended` convenience fields are gone; the client reads `insurer.display` and sets its own pended ID. `app/api/pas/pended/[id]/route.js` returns `{status, authNumber, vendor, responseBundle}`. `_simulateDenial` survives as a documented demo flag.

### Rule Ingestion Pipeline (`app/api/extract/`, `app/api/commit-rules/`, `scripts/extractPreIngested.py`)

1. Upload PA grid PDF via `/um` UI
2. `app/api/extract/` spawns `scripts/extractPreIngested.py` (pdfplumber, word-position grouping)
3. Extracted rules staged in memory; diff surfaced in UM dashboard
4. Quality gate → commit upserts staged rules into `rules` section and writes snapshot to disk

**Pre-ingested snapshot**: `data/preIngestedRules.json` loads via `app/api/rules/load-pre-ingested/` so the demo works without Python.

### Key Files

**Library modules** (`lib/`) — read these before touching the routes that use them:

- `lib/db.js` — all persistence, plus `logTransaction(actor, action, details, meta={})` where `meta` is spread into the log entry. Understand this first.
- `lib/patients.js` — **single source of truth** for the four demo patients, `PRIOR_PLAN_HISTORY`, and `PATIENT_ID_BY_SUBSCRIBER`. Pure data, no `fs`, so client components can import it. Do not reintroduce local patient copies in routes or surfaces.
- `lib/seed.js` — `buildSeedEntries(db)`, replays three demo arcs. Uses the real `generateX12_278()` so the translator drawer opens on seeded traffic.
- `lib/fhir.js` — PAS profile constants and `wrapPasResponseBundle()`
- `lib/eob.js` — `buildEob()`, CARIN BB v2.2.0 Professional NonClinician EOBs with three `total[]` slices (submitted, paidtoprovider, memberliability)
- `lib/auth.js` / `lib/smartClient.js` — server-side scope enforcement and client-side token caching
- `lib/keys.js` — the RS384 keypair, sourced from `SANDBOX_PRIVATE_KEY_B64`. `keysAvailable()`, `getPublicJwk()`, `getKid()`, `signRs384()`, `verifyRs384()`. Read env at call time. Backs both `lib/auth.js` (inbound) and `lib/epicBackend.js` (outbound)
- `lib/epicBackend.js` — outbound SMART Backend Services client to Epic's public FHIR sandbox. Same four-mode gating shape as `lib/availity.js` (`disabled | mock-forced | mock-no-credentials | live`). `EPIC_BACKEND_CLIENT_ID` + a configured keypair is what flips it to `live`. Mock modes return canned Patient resources for Epic's seven well-known test patients, so the demo works with zero credentials
- `lib/availity.js` — outbound Availity Coverages (X12 270/271 eligibility) client, the pattern `lib/epicBackend.js` mirrors. Empirically corrected: OAuth scope is `healthcare-hipaa-transactions-demo` alone (Availity's blog example says dual scope, which fails); demo-tier responses are synchronous (Service Reviews' async 202+poll shape does not apply). Fires from `/ehr` at order-sign time as a real eligibility check, alongside Optum's CRD second opinion.
- `lib/optumBackend.js` — outbound client to Optum's real payer sandbox, same four-mode gating shape. Covers the full CRD order-sign → DTR questionnaire-package → PAS Claim/$submit chain plus Provider Access $bulk-member-match, wired into both `/ehr` and `/um`. `OPTUM_CLIENT_ID` + `OPTUM_CLIENT_SECRET` flips it to `live`. Token endpoint is form-encoded despite Optum's own docs showing JSON; the CDS Hooks invocation path (`crd-order-sign`) does not match the `id` field in Optum's own discovery response — see `docs/integrations.md`
- `lib/pendedReview.js` — request-driven pended finalization
- `lib/basePath.js` — `BASE_PATH` and `apiUrl()`
- `lib/python.js` — `runPython` plus a cached `probePdfExtraction()` behind `app/api/extract/health/`
- `lib/routing.js` — vendor routing helpers

**Routes and surfaces:**

- `app/api/cds-services/order-sign/route.js` — CRD matching engine; logs NPI and patientId on every call
- `app/api/pas/x12Generator.js` — FHIR → X12 278 mapping
- `app/api/fhir/metadata/route.js` — CapabilityStatement; `app/api/cds-services/route.js` — CDS discovery
- `app/um/providerAccess.jsx` — Provider Access panel (NPI lookup, patient panel, event log)
- `app/um/p2pExchange.jsx` — P2P Exchange panel (3-step member-match + history flow)
- `app/patient/page.jsx` — Patient Access Portal surface
- `app/um/stagingData.js` — PDF pattern matchers and staging helpers
- `data/preIngestedRules.json` — canonical 3,154-rule snapshot, committed. Genuinely extracted from the four BCBSIL grid PDFs, which the `extractedFrom` field and the per-rule `source_page` provenance both record. Re-extract with `scripts/extractPreIngested.py`, per `docs/conformance.md`. Do not reintroduce a procedural rule synthesizer: an early scaffold that padded the index with fake rules was removed in 2026-07, because it would overwrite the real snapshot and it undercuts the repo's central claim of using real grid data.

**Route rendering**: parameter-less GET handlers need `export const dynamic = 'force-dynamic'`, or Next 14 statically optimizes them at build and they ship frozen build-time data. Already applied to `app/api/rules/`, `app/api/logs/`, `app/api/schema/`. Check the build route table for `ƒ` rather than `○` after adding a new one.

### Static Assets

- `data/questionnaires/` — 7 FHIR R4 Questionnaire templates (served by `app/api/questionnaire/[id]/`)
- `data/cql/` — 6 CQL library stubs for DTR pre-population (served by `app/api/cql/[id]/`)

## Deployment

- **Live at `https://surakshith.com/cms-0057`.** Firebase Hosting (project `halogen-perception-rk8sk`) rewrites `/cms-0057` and `/cms-0057/**` to the `cms-0057-demo` Cloud Run service in `us-central1`. The Hosting config lives in the separate, private `surakshith.com` repo.
- Raw Cloud Run URL, still valid and useful for bypassing the proxy when debugging: `https://cms-0057-demo-420776046740.us-central1.run.app/cms-0057`
- CI: every push to `main` builds and deploys via `.github/workflows/deploy-cloudrun.yml`, using keyless Workload Identity Federation. Organization policy blocks service account keys, so do not try to add one. All identifiers are hardcoded in the workflow and nothing needs configuring on GitHub.
- `min-instances 0`, `max-instances 1` keeps it inside the always-free tier and keeps in-memory state coherent. Cold starts take a few seconds. Auto-seed covers the state reset.
- Manual deploy from a workstation: `gcloud run deploy --source .`

## Current Status

All four CMS-0057-F mandated FHIR APIs are implemented, conformance-passed, deployed, and documented. Prose history lives in `docs/case-study.md`.

Completed since the APIs first landed:
- Deployability and self-guiding first visit: auto-seed, two-mode demo reset, `force-dynamic` routes, Python-absent degrade, `basePath`
- Conformance pass: `lib/patients.js` consolidation, PAS Bundle wrap plus `meta.profile`, CDS discovery, CapabilityStatement, US Core plus CARIN BB on Patient Access, FHIR Bundle from P2P, SMART demo JWT enforcement
- Hosting: Cloud Run, keyless WIF CI, Firebase Hosting rewrite at the custom domain
- Showcase: README split into a lean entry point plus `docs/`, 9 Playwright screenshots, `docs/demo-script.md`, `docs/case-study.md`

Reference documents kept for history, not current state: `provider-patient-p2p-research.md` (scoping notes that preceded the three access APIs) and `CMS-0057-F-overview.md` (regulatory framing).

## Next Steps

No fixed order. Pull from here when picking up a work session.

1. **Transaction log persistence** — the log, pending map, and committed rules are in-memory and reset on restart and on scale-to-zero. A debounced write into `database.json` with a max-size trim, hydrated on first `getLog()`, would survive a restart. Interacts with the auto-seed trigger: skip the demo seed when a persisted log exists.

2. **Bulk FHIR `$export` for P2P history** — replace the synchronous searchset Bundle with a kick-off returning 202 plus a polling `Content-Location`, a poll endpoint returning an NDJSON manifest, and NDJSON output over the same resources `lib/eob.js` already builds. `p2pExchange.jsx` needs a poll-and-fetch step added to step 3.

3. **More agentic PDF ingestion** — `scripts/extractPreIngested.py` is pattern and regex based today. An LLM classification and extraction pass over the text pdfplumber already pulls, with the regex path as a confidence-gated fallback, feeding the same staged-rules shape `app/api/extract/route.js` expects.

4. **CMS-0062-P roadmap items** — drug-benefit PA path, drug-specific decision timeframes, simulated endpoint registry, version-pinned profile URLs, Da Vinci CDex attachments. These are described in README.md and should stay there rather than being duplicated here.

Shipped since the list above was last trimmed: asymmetric SMART auth (RS384 + JWKS, `lib/keys.js`), an outbound SMART Backend Services client to Epic's FHIR sandbox (`lib/epicBackend.js`), and a real payer integration with Optum (`lib/optumBackend.js`) covering the full CRD → DTR → PAS chain plus Provider Access, live and verified — see `docs/integrations.md` for both outcomes.

## Writing and Documentation Voice

Any README edits, architecture docs, comments written in the user's voice, or other user-facing prose must follow these rules. A longer voice fingerprint document used to be referenced here but no longer exists, so the rules below are authoritative. Ask the user for it if a judgment call is not covered here.

- No contractions, no em-dashes, no semicolons, no exclamation marks
- Bullets for technical writing - split long, multi-clause sentences into individual bullets. Tighten for brevity and clarity, not for punchiness or impact
- In technical writing, use `→` for process flows, not comma-separated prose runs
- No AI-tells: no "honest framing", no dramatic colon setups, no short punchy declaratives for effect
- Hedge claims; lead from experience; do not make universal pronouncements
