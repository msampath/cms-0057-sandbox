# Conformance notes

Implemented against the specifications:

- CDS Hooks 2.0 discovery at `GET /api/cds-services` and the `order-sign` service at the spec's `{baseUrl}/cds-services/{id}` shape, returning cards plus a `coverage-information` system action per Da Vinci CRD STU 2.2.1. The action updates the order (a ServiceRequest) with one complex `ext-coverage-information` extension: relative sub-extensions, `date` as a date, a `coverage-assertion-id`, and `satisfied-pa-id` only when `pa-needed` is `satisfied`, per the CRD StructureDefinition and its invariants. The route reads a standard hook: `context.patientId`, the first ServiceRequest in `context.draftOrders`, and the advertised `patient` and `coverage` prefetch, and it targets the draft order's id in the update
- PAS request and response Bundles of type `collection` claiming the published Da Vinci PAS profiles, with `ClaimResponse.use: preauthorization` and `meta.profile` on the ClaimResponse
- US Core 6.1.0 Patient (member number as an MB-typed identifier, the 6.1.0 mandatory elements, and the Must Support elements the demo has data for, with race and ethnicity recorded as NullFlavor `ASKU` rather than invented) and CARIN BB shaped Coverage and ExplanationOfBenefit, with totals sliced by the C4BB adjudication value set (submitted, paid to provider, member liability)
- `$member-match` accepting and returning pure Parameters per the HRex operation, with no convenience fields outside the spec shape
- a FHIR CapabilityStatement at `GET /api/fhir/metadata` declaring the resources, operations, and implementation guides
- SMART-style token issuance and enforcement: `client_credentials` grants, scoped patient/system tokens, 401 with `WWW-Authenticate` on missing tokens, 403 naming missing scopes
- asymmetric signing per the SMART `client-confidential-asymmetric` profile: RS384 (not RS256, which the profile does not permit), a `kid`-bearing JWK published at `GET /api/.well-known/jwks.json`, `jwks_uri` advertised in the SMART discovery document. The same keypair signs this sandbox's own tokens and the client assertion this sandbox sends as an outbound Backend Services client to Epic's FHIR sandbox (`lib/epicBackend.js`), so a verifier only fetches one JWKS URL either way
- the verifier pins the algorithm to whatever mode is active and rejects a token signed with the other algorithm before checking the signature, closing the alg-confusion class of attack rather than accepting either
- the verifier also requires the sandbox's own `iss` and `aud`, and compares HS256 signatures in constant time. SMART discovery advertises only what the demo token endpoint does: `client_credentials`, v1-style scopes, no client authentication
- the X12 278 request follows the TR3 loop layout for the elements it carries: `UM*HS*I` with the service type in UM03, `HI*ABK` for the ICD-10 diagnosis, and the procedure in a 2000F `SV1*HC` segment. The PAS Claim carries the R4 required elements (type, created, provider, priority, insurance) and `Claim.diagnosis`, and HCPCS codes such as J0717 use the HCPCS system rather than CPT

Added for CMS-0062-P (proposed), each checked against hl7.org, ecfr.gov, or the proposed rule during the build:

- PAS determinations in the PAS `extension-reviewAction` on `ClaimResponse.item.adjudication`: X12 306 action codes (`A1`, `A3`, `A4`) and X12 886 reason codes. `outcome` is `complete` for every decision, since PAS 2.2.1 binds it to `complete | error | partial`
- the X12 278 response carries the decision in `HCR`. `AAA` appears only on a validation error, with a Code Source 901 reject reason
- versioned canonicals from one registry (`IG_REGISTRY` in `lib/fhir.js`): PAS and CRD 2.2.1, CARIN BB 2.2.0, US Core 6.1.0, PDex 2.0.0, and DTR unversioned because its questionnaires are not built to a version
- drug PAs in Patient Access, Provider Access, and Payer-to-Payer as ExplanationOfBenefit resources with `use: preauthorization`, PDex's own `extension-reviewAction`, and the `allowedunits` / `denialreason` slices. The `denialreason` reason is a CARC code, as the profile requires
- CDex 2.1.0 solicited attachments: the attachment-request `Task` (`attachment-request-code` from PASTempCodes) and `$submit-attachment` with the operation's parameters and cardinalities
- base FHIR `Endpoint` resources for the endpoint report. The NDH Endpoint profile is the alternative CMS asked about and is not claimed

Known gap, recorded as a finding: the PDex Prior Authorization profile binds `item.productOrService` to CPT, HCPCS, and HIPPS. An NDC-coded pharmacy-benefit PA cannot conform, so that EOB keeps the structure and does not claim the profile. Borrowing J0717 would be worse, since that code excludes self-administration.

Simulated, by design and labeled in the UI:

- when no keypair is configured (`SANDBOX_PRIVATE_KEY_B64` unset), token issuance falls back to short-lived HS256 demo JWTs with a shared secret, so the demo stays usable without provisioning a key
- CQL is executed for one library end-to-end (`data/cql/MRIBrainPrepopulation.cql` compiled to `data/cql/elm/MRIBrainPrepopulation.elm.json`, evaluated via `lib/cql.js` on top of `cql-execution` + `cql-exec-fhir`, wired into `/ehr` for Epic scenarios via `POST /api/dtr/prepopulate` — Bundle sourced from Epic through `fetchEpicPatientBundle`). The other six libraries under `data/cql/` remain hardcoded-value stubs; the pipeline is the work, adding a define is one CQL edit + one ELM re-translation + one linkId heuristic
- the X12 278 is illustrative rather than TR3 005010X217 conformant, and receiver IDs are realistic-looking placeholders
- the clinical review on pended requests is a timed simulation finalized on poll, and since CMS-0062-P it starts only when the requested CDex attachment arrives. Production would run a durable queue and a worker delivering real rest-hook notifications
- NCPDP SCRIPT ePA, RTPB, and F&B messages are illustrative XML. The NCPDP standards and code lists are licensed, so element structure is simplified and no NCPDP code values are reproduced
- the drug PA clinical criteria (step therapy, TB screening) are illustrative, not BCBSIL policy. The J0717 rule itself is the real grid row
- decision clocks are computed and displayed. The sandbox decides in seconds, so the clocks show the legal due time rather than drive it
- the FFE issuer exception is shown as a flag with an end date. The proposed rule makes it a justification and compliance-plan process, and the UI labels the end date as a position rather than rule text
- the David Kim scenario is illustrative: Illinois moved to a state-based exchange for plan year 2026, so a BCBSIL individual-market member would not be on an FFE
- usage and PA metrics are in-memory counts. The sandbox has no appeal flow, so appeals and overturns stay at zero
- the clearinghouse is a single in-process hop that checks the PAS profile and version. It does not model routing, batching, or X12 translation
- the transaction log, pending map, and committed rules live in process memory and a local JSON file, reset on restart, and re-seed on first touch. Production would use a persistent FHIR store
- prior plan histories in the P2P exchange are seed data in `lib/patients.js`, and behavioral health rules are overridden to `managed_by: "Lucet"` because the BCBSIL BH grid lists BCBSIL as the contact while Lucet is the actual BH utilization management vendor

## Regenerating the pre-ingested snapshot

The snapshot at `data/preIngestedRules.json` is committed so the sandbox runs without Python. To re-extract from updated source PDFs, run each extractor against the corresponding file and then merge the four output JSONs.

```powershell
python scripts/extractPreIngested.py ma       <path>/2026-ma-pa-codelist-q2.pdf                          /tmp/ma.json
python scripts/extractPreIngested.py medsurg  <path>/2026-commercial-med-surg-pa-code-list.pdf           /tmp/medsurg.json
python scripts/extractPreIngested.py pharm    <path>/2026-commercial-specialty-pharmacy-pa-code-list.pdf /tmp/pharm.json
python scripts/extractPreIngested.py bh       <path>/2026-commercial-bh-pa-code-list.pdf                 /tmp/bh.json
```
