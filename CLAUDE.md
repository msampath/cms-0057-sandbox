# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

A Next.js 14 sandbox simulating the **Da Vinci burden-reduction workflow** (CRD → DTR → PAS → adjudication) for healthcare provider-payer interoperability, using real BCBSIL 2026 PA grid data (~3,154 rules). Deployed to Google Cloud Run and served at `surakshith.com/cms-0057` through a Firebase Hosting rewrite. It also models the proposed follow-on rule CMS-0062-P (branch `cms-0062-p`, plan in `docs/cms-0062-p-implementation-plan.md`, phases 0 to 7). It has four browser surfaces:
- `/ehr` — Provider EHR + DTR SMART surface (order picker, CDS card, questionnaire, PAS submit, certolizumab drug orders on both benefits, decision clocks, CDex attachment answer, clearinghouse toggle)
- `/um` — Payer UM Dashboard (rules explorer, schema browser, live traffic feed, PDF ingestion pipeline, Provider Access, P2P Exchange, Standards, Registry & Metrics)
- `/patient` — Patient Access Portal (coverage card, PA history, drug PAs, SMART scopes display)
- `/pharmacy` — Pharmacy PA lookup (CMS-0062-P)

**All four CMS-0057-F mandated FHIR APIs are now implemented:**
- PA API (45 CFR 156.223) — CRD → DTR → PAS flow; implemented in earlier sessions
- Provider Access API (45 CFR 156.222(a)) — `GET /api/provider-access?npi={npi}`; Provider Access tab in `/um`
- Patient Access API (45 CFR 156.221(a)) — `GET /api/patient-access?patientId={id}`; `/patient` surface
- Payer-to-Payer API (45 CFR 156.222(b)) — `POST /api/payer-to-payer/member-match` + `GET /api/payer-to-payer/history/[patientId]`; P2P Exchange tab in `/um`

## Commands

```powershell
npm run dev          # Start dev server at http://localhost:3000/cms-0057
npm run build        # Production build
npm run lint         # ESLint (next/core-web-vitals)
npm run screenshots  # Playwright capture into docs/screenshots/ (needs a running server)
npm run regression   # API regression checks (needs a running server)
npm run ui-smoke     # Playwright load of every surface and /um tab, fails on console errors and on any unexpected 4xx or 5xx (needs a running server)
node scripts/testElm.mjs  # pass/fail check of the hand-authored MRI Brain ELM (no server needed)
```

**Base path**: the app serves under `basePath: '/cms-0057'` everywhere (dev, Docker, prod), so the root URL intentionally 404s. Next rewrites `next/link` and static assets automatically, but **not** literal `fetch('/api/...')` calls in client components. Every client fetch must go through `apiUrl()` in `lib/basePath.js`. A missed call site 404s only in the browser, so a full click-through of all four surfaces is the test.

No unit test framework. Automated checks are lint plus the two scripts above, run against `npm start` after `npm run build`. Each CMS-0062-P phase adds its checks to `scripts/regression.mjs` (one function per phase) and its surfaces to `scripts/uiSmoke.mjs`.

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
5. Plan-level PA default (`plans[].requires_pa_by_default`, so COMM-HMO needs PA for a code with no grid rule and no category default)

**Vendor routing**: BCBSIL by default; oncology biologics (J9035 + C/D0-49 diagnosis codes) → Carelon; behavioral health → Lucet; imaging fallback → EviCore.

Returns CDS Hooks 2.0 cards (info/warning/critical/hard-stop) + a `coverage-information` system action per Da Vinci CRD STU 2.2.1.
- The action updates the order: a `ServiceRequest` for the ordered code carrying one complex `ext-coverage-information` extension, built by `coverageInformationOrder()` in `lib/fhir.js`. Sub-extensions use relative urls (`covered`, `pa-needed`, `billingCode`, `date` as `valueDate`, `coverage-assertion-id`), and `satisfied-pa-id` appears only with `pa-needed` satisfied. Read it with `readCoverageInformation()`. Do not go back to a Task or to `#covered`-style flattened urls
- The order must agree with the card: a gold card is `satisfied` (with the program as the PA id), a category default carries its own values, and a code with no grid rule is `covered` with `no-auth`
- A gold card needs the enrolled NPI. A request with no NPI gets no exemption
- The route reads a standard CDS Hooks request as well as the sandbox shape: the first ServiceRequest in `context.draftOrders` (its CPT or HCPCS coding, http or https system), `context.patientId` ahead of `prefetch.patient` (used only if it is a Patient), the `prefetch.coverage` Bundle, and `context.userId` for a demo practitioner's NPI. Draft orders with no readable code get an "Ordered code could not be read" card and a `conditional` answer, never `no-auth`
- The hard-stop debug flag always yields the blocking card, right after the gold-card check, and the order says `not-covered`
- Diagnoses travel with the hook as Condition resources in `body.conditions` and on the PAS Claim as `Claim.diagnosis`. R4 Patient has no `condition` element. `lib/routing.js` reads codes through `conditionCodes()` and `claimDiagnosisCodes()`

Every `logTransaction` call in this route now carries `{ npi, patientId, code }` meta, including the `COVERAGE-INFORMATION ACTION` entry. This meta is what enables the Provider Access and Patient Access APIs to filter the log by NPI and patient. The PAS decision logs (`pas/submit`, pended finalization, seed) carry the requesting NPI too, so Provider Access shows item PA decisions. `logTransaction` drops a `patientId` or `npi` that is not a plain identifier, trims other meta strings, and caps each entry's `details` at 128K characters, so no single request can fill the 500-entry log.

### Provider Access API (`app/api/provider-access/`)

`GET /api/provider-access?npi={npi}` — reads the in-memory transaction log, filters by NPI and non-null patientId, groups by patient, and returns a panel of attributed patients with their event history. Requires a Bearer token with `system/Patient.read`, `system/ExplanationOfBenefit.read`, `system/ClaimResponse.read`.

### Patient Access API (`app/api/patient-access/`)

`GET /api/patient-access?patientId={id}` — returns a US Core shaped Patient, a C4BB shaped Coverage, CARIN BB `ExplanationOfBenefit` resources from `lib/eob.js`, SMART scopes, and all transaction log events for that patient. The `/patient` surface polls this every 3 seconds via SWR. Requires a Bearer token with `patient/Patient.read`, `patient/Coverage.read`, `patient/ExplanationOfBenefit.read`, `patient/ClaimResponse.read`.

The response keeps a `{smartScopes, patient, coverage, eobs, events}` envelope rather than being a pure FHIR Bundle, because the portal needs the event stream. That trade-off is noted in `docs/conformance.md`.

### Payer-to-Payer API (`app/api/payer-to-payer/`)

Two endpoints together simulate the Da Vinci PDex `$member-match` + history exchange. Both require system scopes.
- `POST /api/payer-to-payer/member-match` — accepts a FHIR Parameters body (`MemberPatient` + `CoverageToMatch`); matches by `subscriberId` first, then by patient ID; returns a **pure Parameters response** with `MemberIdentifier`. No underscore-prefixed convenience fields. The client parses `MemberIdentifier.valueIdentifier.value` to build the history URL.
- `GET /api/payer-to-payer/history/[patientId]` — returns a **searchset Bundle**: the prior-plan Coverage (with `period.end` at disenrollment), one ClaimResponse per prior PA (`use: preauthorization`, the PAS `extension-reviewAction` on `addItem.adjudication` with an X12 306 action code and, for denials, an X12 886 reason code), and CARIN BB EOBs.

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

`finalizePendedIfDue(id)` is **request-driven**, not timer-driven. Cloud Run scales to zero and does not keep `setTimeout` callbacks alive, so the client poll decides whether the 8-second `reviewWindow()` has elapsed. Do not reintroduce a timer here. Since CMS-0062-P Phase 6, a pend waits for its CDex attachment (`awaitingAttachment`), and the window starts when `$submit-attachment` receives the final one.

### FHIR ↔ X12 Duality (`app/api/pas/`, `app/api/pas/x12Generator.js`)

PAS endpoint receives a FHIR Bundle (Patient + Coverage + Practitioner + Claim + QuestionnaireResponse). The FHIR Bundle is kept as the source of truth, and an X12 278 is generated in parallel as a projection for legacy adjudication.
- The 278 request uses `UM*HS*I*<service type>`, `HI*ABK` for the ICD-10 diagnosis from `Claim.diagnosis`, and a 2000F service loop with `SV1*HC:<code>`
- Every Bundle value goes through `x12Safe()`, which strips the `~ * : ^` delimiters The `/um` translator drawer makes the field-to-segment mappings inspectable in real time.

**Response shape**: all three return sites wrap the result via `wrapPasResponseBundle()` in `lib/fhir.js` — a `Bundle.type = 'collection'` (pinned by the PAS IG, not `transaction-response`) holding the ClaimResponse plus the order (`ServiceRequest` with coverage-information), or the CDex attachment-request Task on a pend, each with a `urn:uuid:` fullUrl. `ClaimResponse.type` echoes the Claim's type, default `professional`. The ClaimResponse carries `meta.profile`. The old `_routedTo` and `_wasPended` convenience fields are gone; the client reads `insurer.display` and sets its own pended ID. `app/api/pas/pended/[id]/route.js` returns `{status, authNumber, vendor, responseBundle}`. `_simulateDenial` survives as a documented demo flag.

**Determination encoding**: every ClaimResponse uses `outcome: 'complete'` (PAS binds outcome to `complete | error | partial`, so `queued` is invalid even for pends). The decision is the PAS `extension-reviewAction` on `item[].adjudication` (or `addItem[].adjudication` in P2P history), built by `claimResponseItems()` / `reviewAdjudication()` in `lib/fhir.js`: X12 306 action `A1` certified, `A3` not certified, `A4` pended, plus an X12 886 reason code on denials. Clients read it with `readReviewAction()`, never from `outcome` or `error[]`. The X12 278 response carries the same decision in `HCR` via `generateX12_278_Response({ action, reasonCode })`, with no `AAA` segment on decisions. The one `outcome: 'error'` path is a real validation failure (Bundle with no Claim or Patient): `pasErrorClaimResponse()` returns an X12 901 reject reason plus `extension-errorFollowupAction`, and the 278 carries `AAA*N**15*C` instead of `HCR`.

### Drug PA: one drug, two benefits (CMS-0062-P, `lib/drugPa.js`)

Certolizumab pegol (Cimzia) is the demo drug because its real grid row (J0717, 2026 commercial specialty pharmacy list, page 6) reads "not for use when drug is self administered". Adalimumab is not on the grid, and synthetic rules are not allowed.
- Clinic-administered → medical benefit → CRD (J0717 binds the generated `drug-certolizumab` questionnaire) → DTR → PAS
- Self-administered → pharmacy benefit → `POST /api/drug-pa/pharmacy` (step `benefit`: RTPB, F&B lookup, PAInitiation; step `submit`: PARequest → PAResponse) → Prime Therapeutics
- The benefit step opens an ePA case (`openEpaCase()` in `lib/db.js`, cleared by reset) and the server keeps its clock start. A submit reuses a case only for the same patient and drug, and ignores any client `receivedAt`
- Answers are cut to the drug's own question linkIds (`sanitizeDrugAnswers()`). A request with no answers (`noAnswers`) or a forced debug denial (`debugForced`) is not a model decision. It leaves the shared determination and the metrics alone, and it does not replace a model decision already on that track. It is kept as `lastAttempt` beside that decision, which `SharedRecord` in `/ehr` shows, so the access APIs keep showing the decision
- Both tracks call the same `decideDrugPa()` and share `DRUG_DENIAL_REASONS` (X12 886 code per reason). The DTR Questionnaire and the NCPDP question set are generated from the same `questions` array
- One in-memory record per patient + drug in `lib/db.js` (`upsertDrugPaRecord`), cleared by demo reset, read at `GET /api/drug-pa/record`. Each track prefills from it, so a drug moving between benefits is not re-asked
- `lib/ncpdpGenerator.js` builds illustrative XML. NCPDP code lists are licensed and not reproduced, and every message says it is not a certified payload
- Structured NCPDP payloads are logged without patient meta (like the X12 278 request) and render in the `/um` feed through `NcpdpToggle`

### Drug PA in the access APIs and at the pharmacy (CMS-0062-P Phase 4)

- `lib/drugPaAccess.js` → `drugPriorAuthEobs(patientId)` turns each benefit track on a shared drug PA record into a PDex Prior Authorization EOB (`buildPriorAuthEob()` in `lib/eob.js`). Track entries that are not model decisions (`debugForced`, `noAnswers`) are left out. Each track keeps its own `reasonKey`
- The PDex EOB uses PDex's own `extension-reviewAction` (not the PAS one) on `item.adjudication`, with the `allowedunits` or `denialreason` slice from `PDexAdjudicationDiscriminator`
- Patient Access returns them as `priorAuthorizations`, Provider Access per attributed patient, and Payer-to-Payer history carries prior-payer drug PAs from `PRIOR_PLAN_HISTORY[*].priorDrugPAs`. `p2pExchange.jsx` splits `use: preauthorization` EOBs from CARIN BB claims
- `/pharmacy` → `GET /api/pharmacy/pa-status?memberId=&ndc=` (system scopes) returns the same EOBs plus RTPB and F&B, so a dispensing pharmacy sees the decision the prescriber saw
- `lib/integrationLabel.js` labels the Optum and Availity panels by mode: "sandbox response" when `live`, "sandbox response (saved copy)" when `mock-*`, because no call is made in mock mode

### Reporting and metrics (CMS-0062-P Phase 5)

- `GET /api/registry/endpoints` → a Bundle of base FHIR `Endpoint` resources for the four APIs (the rule's primary proposal; NDH is the alternative and is not claimed). Addresses use the forwarded origin, like SMART discovery
- `lib/withUsage.js` wraps the API route handlers. It parses a POST body once, then replaces `request.json()`, so a bad body is a 400 where the handler reads it and auth still runs first. A chunked POST gets 411 and one over 1 MB gets 413. POST routes that `withUsage` does not wrap call `bodyTooLarge()` from `lib/bodyLimit.js` first, with their own limit. A new POST route should do one or the other. It also records one usage event per call in `lib/db.js`: `success`, `unauthenticated` (401 with no Bearer token, the scripted demo step, counted apart), `authFailure` (a rejected Bearer token or 403), `clientError`, `serverError`. Error rate = (authFailure + serverError) / (success + authFailure + serverError). A new API route should export its handler through `withUsage()`
- Every PA decision log entry carries a `pa` tag (`requestId`, `category` item or drug, `benefit`, `determination`, `planType`, times, `forced`). `lib/paMetrics.js` builds the metrics from those tags, so seeded and live traffic count alike. The seed's Jane Doe approval carries one. Forced debug denials are excluded, and MA drug metrics cover Part B only
- `GET /api/metrics` and the `/um` Registry & Metrics tab show both. Usage counters reset with the demo

### CDex attachments and intermediaries (CMS-0062-P Phase 6)

- A pend (15820) now waits for a document. The PAS response Bundle carries a CDex 2.1.0 attachment-request `Task` (`lib/cdex.js`: `code` is `attachment-request-code` from PAS's `PASTempCodes`, tracking-id, contained Patient and PractitionerRole, `payer-url` input). The pending entry has `awaitingAttachment: true` and `finalizePendedIfDue()` leaves it pended
- `POST /api/cdex/$submit-attachment` validates the Parameters (TrackingId, AttachTo, MemberId, ProviderId or OrganizationId, Attachment with one Content, Final) and, on a final submission, starts the 8-second review window. The next poll finalizes. 400 invalid, 404 unknown TrackingId, 409 already finalized. The `/ehr` pended panel has a "Submit requested attachment" button
- `POST /api/clearinghouse/pas` is a simulated clearinghouse in front of PAS (`lib/clearinghouse.js`): the Bundle must claim the PAS request profile, a versioned profile must be the sandbox's PAS version or the 170.215 version until the proposed 2028 expiry, and a Claim and Patient must be present. Failures get a 422 OperationOutcome and never reach the payer. `/ehr` has a clearinghouse toggle and a debug option to claim PAS 1.1.0
- The `/ehr` PAS request Bundle now claims the versioned profile from `IG_REGISTRY`

### Rule Ingestion Pipeline (`app/api/extract/`, `app/api/commit-rules/`, `scripts/extractPreIngested.py`)

1. Upload PA grid PDF via `/um` UI
2. `app/api/extract/` spawns `scripts/extractPreIngested.py` (pdfplumber, word-position grouping)
3. Extracted rules staged in memory; diff surfaced in UM dashboard
4. Quality gate → commit inserts new staged rules into the `rules` section (existing keys are left as they are) and writes the snapshot to disk

A rule's identity is `match_type | service_code | service_category | source_label`, in `/api/commit-rules` and in the `/um` staging diff alike. The same code can sit on the MA and commercial grids with different answers, and `ruleMatchesPlan()` picks by `source_label`. The commit route validates every rule, caps the active index and the snapshot at 8,000 rules, and writes the snapshot atomically. Code rules without a CPT or HCPCS shape are left out of a commit and shown as skipped.

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
- `lib/epicBackend.js` — outbound SMART Backend Services client to Epic's public FHIR sandbox. Same four-mode gating shape as `lib/availity.js` (`disabled | mock-forced | mock-no-credentials | live`). `EPIC_BACKEND_CLIENT_ID` + a configured keypair is what flips it to `live`. Mock modes return canned Patient resources for Epic's seven well-known test patients, so the demo works with zero credentials. Two entry points: `fetchEpicPatient(fhirId)` for the narrow Patient read (scope `system/Patient.read`, env `EPIC_BACKEND_SCOPES`) and `fetchEpicPatientBundle(fhirId)` for the DTR-CQL bundle read (scope `system/Patient.read system/Condition.read system/Observation.read`, env `EPIC_BACKEND_BUNDLE_SCOPES`). Bundle read collects per-resource-type errors into a `warnings[]` array so a denied Condition/Observation scope does not kill the whole flow. Token cache is keyed by scope string
- `lib/cql.js` — server-only CQL evaluator. Wraps `cql-execution` v3 + `cql-exec-fhir` (FHIRv401 PatientSource) around a registry of precompiled ELM libraries under `data/cql/elm/*.elm.json`. `evaluateCqlLibrary(libraryId, bundle)` returns `{ libraryId, patientId, results, resourceCounts }`. `cql-execution` runs ELM JSON, not CQL text — there is no pure-JS CQL-to-ELM translator, so ELM must be precompiled offline (cqframework translation service or Java CLI) and committed. The committed MRIBrainPrepopulation ELM was hand-authored when public translators were unreachable. It executes the CQL's full filter (active status, ICD-10-CM, G or R), and `node scripts/testElm.mjs` checks it against positive and negative cases. Run it after any ELM change
- `lib/availity.js` — outbound Availity Coverages (X12 270/271 eligibility) client, the pattern `lib/epicBackend.js` mirrors. Empirically corrected: OAuth scope is `healthcare-hipaa-transactions-demo` alone (Availity's blog example says dual scope, which fails); demo-tier responses are synchronous (Service Reviews' async 202+poll shape does not apply). Fires from `/ehr` at order-sign time as a real eligibility check, alongside Optum's CRD second opinion.
- `lib/optumBackend.js` — outbound client to Optum's real payer sandbox, same four-mode gating shape. Covers the full CRD order-sign → DTR questionnaire-package → PAS Claim/$submit chain plus Provider Access $bulk-member-match and the async $davinci-data-export chain (kickoff → status poll → NDJSON download), wired into both `/ehr` and `/um`. `OPTUM_CLIENT_ID` + `OPTUM_CLIENT_SECRET` flips it to `live`. Empirical quirks documented in `docs/integrations.md`: token endpoint is form-encoded despite Optum's own docs showing JSON; the CDS Hooks invocation path (`crd-order-sign`) does not match the `id` field in Optum's own discovery response; the sandbox has no real member roster (returns canned data regardless of request content, but marks the exact demographics from its own Try-It request example as matched — those are captured in `lib/optumSandboxMembers.js`). Request shapes are the documented PDex multi-member-match-bundle-in for `$bulk-member-match` and `coverage`+`context` for `$questionnaire-package`
- `lib/optumSandboxMembers.js` — the two demographic profiles Optum's own Try-It docs submit and expect back as matches (captured 2026-08-18 from the OAS request/response examples). Pure data, importable client-side, mirrors `lib/patients.js` shape. Consumed by the `/um` Provider Access panel's source toggle
- `lib/pendedReview.js` — request-driven pended finalization
- `lib/rateLimit.js` — `outboundRateLimit(name, mode)`, a 60-a-minute cap per integration on the Optum, Availity, and Epic routes, applied only in `live` mode. Every new outbound route should call it
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
- CMS-0062-P (proposed), on branch `cms-0062-p`, one commit per phase, each through two adversarial Gemini reviews, then 11 rounds of report-only super-review (Opus 5.5 and Sonnet 5.5, one fix commit per round, until three rounds in a row found nothing above LOW): conformant PAS determinations and CFR citations, IG version registry and Standards tab, one drug on two benefits, decision clocks, drug PAs in the access APIs and `/pharmacy`, endpoint report and metrics, CDex attachments and a clearinghouse hop, US Core 6.1.0. `npm run regression` and `npm run ui-smoke` gate each phase

Reference documents kept for history, not current state: `provider-patient-p2p-research.md` (scoping notes that preceded the three access APIs) and `CMS-0057-F-overview.md` (regulatory framing).

## Next Steps

No fixed order. Pull from here when picking up a work session.

1. **Transaction log persistence** — the log, pending map, and committed rules are in-memory and reset on restart and on scale-to-zero. A debounced write into `database.json` with a max-size trim, hydrated on first `getLog()`, would survive a restart. Interacts with the auto-seed trigger: skip the demo seed when a persisted log exists.

2. **Bulk FHIR `$export` for P2P history** — replace the synchronous searchset Bundle with a kick-off returning 202 plus a polling `Content-Location`, a poll endpoint returning an NDJSON manifest, and NDJSON output over the same resources `lib/eob.js` already builds. `p2pExchange.jsx` needs a poll-and-fetch step added to step 3.

3. **More agentic PDF ingestion** — `scripts/extractPreIngested.py` is pattern and regex based today. An LLM classification and extraction pass over the text pdfplumber already pulls, with the regex path as a confidence-gated fallback, feeding the same staged-rules shape `app/api/extract/route.js` expects.

4. **CMS-0062-P follow-ups** — an appeal flow (the appeal metrics are zero without one), NCPDP cancel and appeal messages, and pharmacy-benefit PAs in the PDex profile if a later PDex version admits NDC codes. When the final rule lands, update `IG_REGISTRY` and `CMS_0062_P_DATES` in `lib/fhir.js` and the clocks in `lib/decisionClock.js`.

Shipped since the list above was last trimmed: asymmetric SMART auth (RS384 + JWKS, `lib/keys.js`), an outbound SMART Backend Services client to Epic's FHIR sandbox (`lib/epicBackend.js`), and a real payer integration with Optum (`lib/optumBackend.js`) covering the full CRD → DTR → PAS chain plus Provider Access, live and verified — see `docs/integrations.md` for both outcomes.

## Writing and Documentation Voice

Any README edits, architecture docs, comments written in the user's voice, or other user-facing prose must follow these rules. A longer voice fingerprint document used to be referenced here but no longer exists, so the rules below are authoritative. Ask the user for it if a judgment call is not covered here.

- No contractions, no em-dashes, no semicolons, no exclamation marks
- Bullets for technical writing - split long, multi-clause sentences into individual bullets. Tighten for brevity and clarity, not for punchiness or impact
- In technical writing, use `→` for process flows, not comma-separated prose runs
- No AI-tells: no "honest framing", no dramatic colon setups, no short punchy declaratives for effect
- Hedge claims; lead from experience; do not make universal pronouncements
