# Conformance notes

Implemented against the specifications:

- CDS Hooks 2.0 discovery at `GET /api/cds-services` and the `order-sign` service at the spec's `{baseUrl}/cds-services/{id}` shape, returning cards plus a `coverage-information` system action per Da Vinci CRD STU 2.2.1 extension URLs
- PAS request and response Bundles of type `collection` claiming the published Da Vinci PAS profiles, with `ClaimResponse.use: preauthorization` and `meta.profile` on the ClaimResponse
- US Core shaped Patient (member number as an MB-typed identifier) and CARIN BB shaped Coverage and ExplanationOfBenefit, with totals sliced by the C4BB adjudication value set (submitted, paid to provider, member liability)
- `$member-match` accepting and returning pure Parameters per the HRex operation, with no convenience fields outside the spec shape
- a FHIR CapabilityStatement at `GET /api/fhir/metadata` declaring the resources, operations, and implementation guides
- SMART-style token issuance and enforcement: `client_credentials` grants, scoped patient/system tokens, 401 with `WWW-Authenticate` on missing tokens, 403 naming missing scopes

Simulated, by design and labeled in the UI:

- authentication uses short-lived HS256 demo JWTs with a shared secret. Production SMART v2 backend services would use registered clients, signed client assertions, and asymmetric keys published through JWKS
- CQL is not executed. DTR pre-population values are hardcoded to match what each library's `define` block would compute for the seed patient
- the X12 278 is illustrative rather than TR3 005010X217 conformant, and receiver IDs are realistic-looking placeholders
- the clinical review on pended requests is a timed simulation finalized on poll. Production would run a durable queue and a worker delivering real rest-hook notifications
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
