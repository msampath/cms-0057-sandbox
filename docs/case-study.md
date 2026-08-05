# Case study: building the CMS-0057-F sandbox

How this project went from a PDF parsing experiment to a deployed working model of all four CMS-0057-F mandated FHIR APIs, running at [surakshith.com/cms-0057](https://surakshith.com/cms-0057) for $0 a month.

I built it in evenings and weekends between May and July 2026, working with Claude Code and Claude Desktop. This document covers what I decided, what broke, and where the AI sat in the loop, because the decisions are the part that transfers to other work.

---

## What shipped

- All four APIs the rule mandates, end to end: Prior Authorization (CRD → DTR → PAS), Patient Access, Provider Access, Payer-to-Payer
- Approximately 3,154 rules extracted from the publicly available BCBSIL 2026 prior authorization grid PDFs, not synthetic fixtures
- A FHIR ↔ X12 278 translator drawer that makes the field-to-segment mapping inspectable while traffic runs
- SMART-style Bearer token enforcement on the three access APIs, demonstrable as a live 401 → token → 200, signed RS384 with a published JWKS
- A live outbound SMART Backend Services connection to Epic's own FHIR sandbox, reading real Epic test patients
- Roughly 7,300 lines of application code across 52 files, including 22 API route handlers

Scale is deliberately small. This is a sandbox for walking through the moving parts, not a production payer stack.

---

## Timeline

| Date | What landed |
|---|---|
| 2026-05-25 | First commit. PDF extraction, schema scaffold, tabbed UM dashboard, upsert of PA grid commits |
| 2026-06-13 | Pended PA flow, structured denial reason codes, `satisfied-pa-id` conformance, the CMS-0057-F overview doc, and a written research plan for the three remaining APIs |
| 2026-07-01 | AGPL-3.0 |
| 2026-07-05 | The three remaining APIs and their surfaces, then deployability, then a seven-commit conformance pass, then hosting, then screenshots and a demo script |
| 2026-07-06 | README split into a lean entry point plus `docs/` |
| 2026-07-28 | Live at `surakshith.com/cms-0057` behind a Firebase Hosting rewrite |

The May and June work happened in Claude Desktop chats. Those transcripts are not on disk, so that stretch of the timeline is reconstructed from commit history and from the documents those sessions produced (`CMS-0057-F-overview.md`, `provider-patient-p2p-research.md`). Everything from July onward is reconstructed from Claude Code session transcripts.

---

## Method

Four habits did most of the work. None of them are novel, but skipping any one of them would have cost more than it saved.

- **Research before code.** Both large build phases opened with a written scoping document rather than a branch. `provider-patient-p2p-research.md` mapped each of the three remaining APIs to its CFR cite and its implementation guide, and listed the open regulatory questions, before a single route existed. It is kept in the repo as a record of what was known at the time.
- **A plan with verification criteria per phase.** Each phase carried its own definition of done. The deployability phase, for example, was not done when the Dockerfile built, it was done when a fresh-clone simulation with the database deleted produced populated surfaces with zero clicks.
- **Phase-scoped commits.** The conformance pass is seven commits, each one a single contract change landed server-side and client-side together, so the demo was never broken between them.
- **Verification stayed manual.** There is no test suite. Lint is the only automated check. Every bug listed below was found by driving the browser, reading a build route table, or curling a live endpoint, not by a passing green check.

---

## Decisions worth explaining

**A managed FHIR store was rejected on cost, then cited anyway.**
AWS HealthLake runs around $0.27 per datastore-hour, roughly $195 a month, for a demo that gets a handful of visits a week. The sandbox uses a file-backed JSON store instead, and the architecture doc names HealthLake as the production path with the reasoning attached. Being able to explain why the cheap thing is in the demo and the expensive thing is in the design is more useful in an interview than pretending the demo is production.

**The hosting decision changed when the constraint was restated.**
The plan started on AWS free tier: Lightsail container plus CloudFront plus Route 53. The constraint was then restated from cheap to free, which is a different requirement. Google Cloud Run at `min-instances 0` plus Firebase Hosting stays inside the always-free tier at demo traffic, so the design moved. Reusing an existing billing-enabled project rather than opening a new account kept the free-tier quota intact, since the free tier is per billing account.

**Path, not subdomain.**
Serving at `surakshith.com/cms-0057` rather than `cms0057.surakshith.com` makes the portfolio and the demo one site with one certificate. The cost is real: `basePath` in `next.config.js`, plus a sweep of every literal `fetch('/api/...')` call through `lib/basePath.js`. Next.js rewrites links and static assets for a base path but not literal fetch URLs, so a missed call site fails with a 404 in production and nowhere else. A full click-through of all four surfaces was the only reliable test.

**Scale-to-zero broke the pended flow, so the flow changed.**
The 8-second pended review ran on a `setTimeout`. A container that scales to zero does not keep timers alive. Rather than pin an instance, finalization became request-driven in `lib/pendedReview.js`: the client poll itself decides whether the review window has elapsed. The infrastructure choice reached back and changed an application behavior, which is usually the sign the infrastructure choice was load-bearing.

**No service account keys.**
Organization policy on the account blocks service account key creation, which broke the obvious CI path. CI moved to Workload Identity Federation, keyless and locked to this repository by attribute condition. The blocker produced the better answer.

**Docker Desktop was broken for weeks and it did not block anything.**
The recurring `npipe` error turned out to be `AutoStart: false` in the settings store, so the engine was simply never running. Until that surfaced, image builds ran remotely through `gcloud run deploy --source`. Worth noting because the correct move was to route around the broken tool rather than stop and fix it first.

---

## What broke

Five real defects, four of which would have been invisible until someone else hit them.

- **Next.js froze three API routes at build time.** Next 14 statically optimizes parameter-less GET route handlers, so `/api/rules`, `/api/logs`, and `/api/schema` would have shipped a snapshot of build-time data. This was never visible in months of development because the app had only ever run under `npm run dev`. Fixed with `export const dynamic = 'force-dynamic'`, verified by reading the build route table for `ƒ` rather than `○`.
- **A gold-card program with an empty provider list gold-carded everyone.** An Advanced Imaging pilot with `providers: []` read as program-wide, so every MRI order skipped prior authorization and the flagship demo arc never fired on a fresh database. Fixed with a sentinel NPI.
- **The seed skipped itself when the first request was a CDS hook.** `logTransaction` wrote to the transaction log before anything called `getDb()`, so the "is the log empty" guard saw a non-empty log and decided seeding had already happened. Fixed by calling `ensureSeeded()` from `logTransaction` as well.
- **The pended scenario used a code that does not pend on that plan.** CPT 15820 is Medicare Advantage only in the real 2026 grids. The scenario moved to the MA-PPO patient rather than bending the data to fit the script, which is the whole point of using real grids.
- **Domain verification failed against a proxied origin.** Firebase Hosting returned conflicting results for the ACME HTTP challenge while the Cloudflare proxy was in front of the record. Resolved by adjusting the record before verification, which is a DNS ordering problem rather than a code one.

---

## Where Claude fit

The build ran across two long Claude Code sessions plus earlier Claude Desktop chats. Approximate shape of the main July session, from the transcript:

- About 1,070 assistant turns against roughly 30 substantive turns from me
- 167 file edits, 157 shell commands, 51 new files
- 10 points where the work stopped and routed a decision back to me as a question

The ratio is the interesting part. Most of my turns were constraints and corrections rather than instructions:

- "I mean, free, not cheap" moved the entire hosting design from AWS to Google Cloud
- "wait on the portfolio" stopped scope creep into a second project mid-phase
- "short and meaningful" rejected a set of over-explained commit messages
- keeping the roadmap in the README overrode a documentation split that was otherwise correct

What I did not delegate: the browser QA, the screenshot pass, and the live endpoint checks. Every defect in the section above came out of one of those. Generated code that looks right and a build that passes lint are not the same as a working demo, and the gap between them is where the interesting failures live.

The regulatory reading was a genuine collaboration. Mapping 45 CFR 156.221 to specific Da Vinci implementation guides, and then to specific profile versions, is the kind of work where a fast reader that cites its sources is useful and a fast reader that does not is dangerous. Every profile canonical URL used here was checked against a published IG rather than accepted from memory, and the ones that could not be confirmed are flagged in `docs/conformance.md`.

---

## Cost

- Hosting: $0 a month. Cloud Run at `min-instances 0` and `max-instances 1`, Firebase Hosting, both inside the always-free tier at demo traffic
- A $5 budget alert on the billing account as a guard
- Effort: planned at roughly 12 to 14 working days, spread across about nine weeks of part-time evenings

The trade for $0 is a cold start of a few seconds after an idle period, and in-memory state that resets on scale-to-zero. The first-touch auto-seed makes that reset invisible, which was the design response rather than a workaround.

---

## External integrations

Added after the initial ship. The sandbox now plugs into public health-IT test tools, so its story is not "this thing runs by itself" but "this thing sits in a real ecosystem":

- **CDS Hooks Sandbox** at `sandbox.cds-hooks.org` calls the CRD engine via the discovery URL. Zero code, just CORS. Verified.
- **SMART App Launcher** at `launch.smarthealthit.org` opens `/ehr` as a launched SMART on FHIR app. Public-client PKCE, patient fetched from the launching FHIR server. Verified end to end.
- **Availity Coverages** is the sandbox's pre-order eligibility check. When a provider signs an order in `/ehr`, we call Availity's real Coverages API (X12 270/271) alongside the CRD hook — a real clearinghouse round trip verifying the patient has active coverage at the payer, live and verified against Availity's demo sandbox. Originally built against their Service Reviews API (X12 278) but pivoted after empirical testing showed the developer credentials we obtained were subscribed to a product that includes Coverages but not Service Reviews. Two real quirks found only by live testing, both worth recording: the OAuth scope Availity's own blog example lists (`healthcare-hipaa-transactions healthcare-hipaa-transactions-demo`, dual) fails with `unauthorized_client` — the single `-demo` scope alone is what works. And demo-tier responses come back synchronously in one shot, not the async 202+poll shape the Service Reviews docs implied would apply.
- **Inferno by ONC** can run its Da Vinci PAS conformance test kit against the deployed URL. CORS and endpoints verified reachable.
- **Epic on FHIR, SMART launch** — three app registrations under `msampath` (CMS Prior Auth, General, Backend Systems), the first two marked Ready for Production. OAuth handshake verified end-to-end against Epic's real sandbox endpoints — non-production client id accepted, ticket generated, Hyperspace login page reached. Resource-scope grants are blocked by Epic's public-sandbox policy for third-party developers under the standalone/EHR-launch path by design; reading actual patient FHIR data through that path requires a customer partnership. Full round-trip launch with patient context stays with the SMART App Launcher (Section 3) which is what Epic's own docs recommend for that purpose.
- **Epic on FHIR, Backend Services** — a separate outbound path from the above, and the one that actually works: the sandbox signs an RS384 `client-confidential-asymmetric` JWT assertion with its own keypair and calls Epic's `client_credentials` token endpoint directly, the path Epic's Developer Testing Guide documents as the intended way for backend apps to connect. It reads real Patient resources for Epic's well-known sandbox patients — full US Core shape, real address and contact data, calculated pronouns, managing organization, not a stand-in. The first 45 minutes of attempts all failed with `invalid_client`, every piece of which was independently ruled out as our own bug before the cause turned out to be Epic's own documented registration sync delay. The next attempt after that window succeeded with no changes on either side.
- **Optum real payer API** — a different kind of integration from the others: Epic is an EHR vendor's sandbox, Availity is a clearinghouse, but Optum's sandbox is a second, independent **payer's** own live implementation of the same CMS-0057-F APIs this sandbox implements. The full CRD order-sign → DTR questionnaire-package → PAS Claim/$submit chain is wired into `/ehr`, running in parallel with this sandbox's own engine and Availity's projection, plus a Provider Access `$bulk-member-match` call wired into `/um`. Live and verified against real UnitedHealthcare-shaped responses. Two of Optum's own documented request shapes turned out to be wrong when tested live — the token endpoint wants form-encoding, not the JSON body their setup docs show, and the real CDS Hooks invocation path (`crd-order-sign`) does not match the `id` field their own discovery response returns — both caught only by empirical testing against the real sandbox, the same discipline that found the Epic and Availity issues.

Together these fill in the columns the sandbox was missing before: EHR-side callers on the inbound and a clearinghouse on the outbound, with a conformance oracle grading both, an outbound path to Epic specifically, and now a second real payer's own implementation of the same mandated APIs. See [docs/integrations.md](integrations.md) for setup steps per tool.

## Still open

Carried in the README roadmap, roughly in the order I would pick them up:

- Transaction log persistence across restarts
- Bulk FHIR `$export` for the Payer-to-Payer history endpoint, in place of the synchronous searchset Bundle
- Asymmetric SMART auth, RS256 plus a JWKS endpoint, in place of the shared HS256 demo secret
- More agentic PDF ingestion, an LLM classification pass over the text the parser already pulls, with the current regex extractor as a confidence-gated fallback
- The CMS-0062-P items, since the proposed rule names the same IG versions this repo already targets

---

## Where to look first

For a reviewer with fifteen minutes:

- `app/api/cds-services/order-sign/route.js` — the CRD matching cascade, which is the closest thing this repo has to a core algorithm
- `lib/db.js` and `lib/seed.js` — how the demo makes itself self-guiding on first touch
- `app/api/pas/x12Generator.js` — the FHIR to X12 278 projection behind the translator drawer
- [docs/architecture.md](architecture.md) — data flow and how a production build would differ
- [docs/conformance.md](conformance.md) — what is implemented against the spec, and what is simulated, stated plainly
