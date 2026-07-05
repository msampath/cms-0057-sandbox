# Demo script

Two artifacts in one file: a storyboard for the recorded walkthrough video, and talking points for driving the demo live in interviews. Both assume the deployed instance or a local run at `/cms-0057`, reset to the seeded baseline (the **Reset demo** button in the UM header).

Pre-staging checklist before recording or screen sharing:

- reset the demo to the seeded baseline and confirm the live feed shows the replayed session
- open three browser tabs in order: the landing page, `/um`, and `/ehr`, with `/patient` ready in a fourth
- have any small text file on the desktop to use as the DTR attachment
- if the deployed instance has been idle, load it once a minute beforehand so the recording does not include the cold start

---

## Video storyboard (two and a half minutes)

| Time | On screen | Suggested narration |
|---|---|---|
| 0:00 | Landing page, slow scroll through the regulatory strip and the four API cards | CMS-0057-F requires payers to expose prior authorization and member data through four FHIR APIs by January 2027. This is a working simulation of all four, built on the real BCBSIL 2026 prior authorization grids, around 3,154 rules. |
| 0:20 | `/um` Rules Explorer, type `70553`, open the rule detail | The payer side starts with the rule index. This MRI Brain rule came out of the actual PDF grid, and the provenance points back to the source file and page. It routes to Carelon and binds a DTR questionnaire. |
| 0:40 | `/ehr`, Jane Doe selected, click **Sign Order** | On the provider side, signing the order fires a CDS Hooks order-sign call. The card says prior authorization is required, names the reviewer, and offers the documentation app. |
| 0:55 | Click **Launch DTR SMART App**, point at the CQL badge, attach the file, submit | The questionnaire is a FHIR resource, and the highlighted answer was pre-populated from CQL logic. Submitting sends a PAS request Bundle. |
| 1:15 | Green approved card with the auth number | The determination comes back as a profiled FHIR ClaimResponse inside a PAS response Bundle, with the authorization number. |
| 1:25 | `/um` Live Traffic Feed, expand the FHIR ↔ X12 drawer, hover a mapping row | The payer feed shows both representations side by side. The FHIR Bundle is preserved as the source of truth, and the X12 278 runs alongside for the legacy adjudication engine, with field-to-segment mappings. |
| 1:45 | `/patient`, Jane Doe, point at the token chip, the EOB table, and the history | The member sees the same determination through the Patient Access API. The portal holds a real bearer token, and the claims are CARIN Blue Button shaped resources. |
| 2:05 | `/um` P2P Exchange, run the exchange, scroll step 3 | When a member changes payers, member match runs on FHIR Parameters, and the prior plan history arrives as a Bundle, including a denied authorization with appeal rights. |
| 2:25 | Landing page footer with the GitHub link | All four mandated APIs, one order, one continuous data story. The code and the deployment pipeline are on GitHub. |

Thirty second elevator variant: 0:00 landing framing → 0:10 sign the order and show the card → 0:20 the FHIR ↔ X12 drawer → 0:30 close on the patient portal showing the same determination.

Recording notes: 1440 wide or larger, cursor visible, no browser bookmarks bar, pause a beat after each click so the state change reads on video.

---

## Interview talking points

Each row pairs a demo beat with the competency it demonstrates, phrased from experience rather than as a claim about the demo.

| Demo beat | For healthcare-focused roles | For general TPM / product roles |
|---|---|---|
| Regulatory strip on the landing page | I read the final rule and the IGs and scoped the build to what 156.221 actually mandates, including the January 2026 operational provisions versus the January 2027 API dates. | Translating a regulation into a buildable requirements set, with dates and scope boundaries made explicit. |
| Rules Explorer provenance | Payer rules live in PDF grids today. The ingestion pipeline, staging review, and quality gate model the data-governance work payers face before any API can exist. | Data quality gating and provenance as first-class requirements, not afterthoughts. |
| CDS card and vendor routing | The cascade models gold-carding, code and category matching, and delegated UM vendors (Carelon, Lucet, EviCore), including conditional oncology routing. | Orchestrating a multi-vendor ecosystem behind one interface, with the routing logic in one shared module. |
| DTR with CQL pre-population | DTR is where burden reduction becomes real for clinicians, and the demo is explicit about what is simulated (CQL is not executed) versus what is spec-shaped. | Being precise in public about what a prototype proves and what it does not. |
| PAS Bundle plus X12 drawer | The FHIR-as-source-of-truth with a parallel X12 278 projection mirrors how payers actually bridge to legacy adjudication during the transition years. | Designing a migration story that keeps the legacy system working while the new interface becomes authoritative. |
| Pended and denial paths | Structured denial reasons with appeal language and decision timeframes are operational requirements of the rule, and both paths render them. | Failure modes and async workflows designed and demonstrated alongside the happy path. |
| Patient portal token chip | The access APIs enforce scoped tokens with a live 401 → token → 200 flow, and the notes say exactly how production SMART v2 would differ. | Building the security walkthrough into the product so the gap between demo and production is stated, not discovered. |
| P2P exchange | Member match and prior plan history follow the HRex and PDex shapes, so a reviewer can compare the wire format against the IGs directly. | Interoperability treated as contract design, where the payload shapes carry most of the product decisions. |
| The deployment itself | The demo runs on a scale-to-zero container at zero monthly cost, with keyless CI deploys, and the README names what a production payer stack would use instead, including managed FHIR stores and their cost profile. | Cost-aware architecture choices, an automated release path, and honest build-versus-buy framing. |

Questions worth inviting, because the demo answers them well: how the rule cascade resolves conflicts, why the PAS response is a `collection` Bundle rather than a transaction, what breaks at scale in the in-memory design and what replaces it, and how gold-carding changes utilization review economics.
