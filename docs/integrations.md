# External integrations

The sandbox is reachable from public health-IT test tools. Every API endpoint sends `Access-Control-Allow-Origin: *`, so browser-based sandboxes can call it directly. The three access APIs still enforce SMART Bearer tokens on top of that.

Base URL for everything below: `https://surakshith.com/cms-0057`.

## 1. CDS Hooks Sandbox

The community-hosted [CDS Hooks Sandbox](https://sandbox.cds-hooks.org) simulates an EHR chart-open workflow and invokes external CDS services against seed FHIR data. Point it at the sandbox to see the CRD engine in action from outside.

Setup:

1. Open [sandbox.cds-hooks.org](https://sandbox.cds-hooks.org)
2. Configure Services (top-right cog) → **Add CDS Services**
3. Discovery URL: `https://surakshith.com/cms-0057/api/cds-services`
4. Save. The `BCBSIL prior authorization requirements` service should appear.
5. Select the `order-sign` hook and submit an order for CPT `70553` on the seeded patient. A CRD coverage-requirements card should return with the DTR launch link and a Da Vinci `coverage-information` system action.

What this proves: the sandbox implements CDS Hooks 2.0 discovery and the Da Vinci CRD 2.2.1 order-sign card contract in a way that a spec-conformant caller can invoke without special configuration.

## 2. Inferno by ONC

ONC's [Inferno](https://inferno.healthit.gov) is the official FHIR conformance testing platform, and is what regulator-required conformance testing runs on. There are relevant test kits for Da Vinci PAS, US Core, and SMART on FHIR.

Setup:

1. Open [inferno.healthit.gov](https://inferno.healthit.gov)
2. Select the **Da Vinci Prior Authorization Support (PAS)** test kit
3. Base FHIR URL: `https://surakshith.com/cms-0057/api`
4. Auth: token endpoint `https://surakshith.com/cms-0057/api/auth/token`, grant `client_credentials`, scope covering the tests being run
5. Run the suite

The sandbox's SMART discovery, `CapabilityStatement`, PAS `Bundle` shape, and token endpoint are all conformance-shaped, so a subset of Inferno tests should pass without modification. Failing tests are useful too: they name the exact spec sections the sandbox does not yet meet.

## 3. SMART App Launcher (Phase 2)

The reference [SMART App Launcher](https://launch.smarthealthit.org) can act as an EHR opening the sandbox's `/ehr` surface as a SMART on FHIR app.

Status: launch handling is being added to `/ehr` in a separate phase. Not yet live.

## 4. Epic on FHIR (Phase 4)

Epic's free developer sandbox at [fhir.epic.com](https://fhir.epic.com) supports SMART on FHIR launch of external apps and has documented Da Vinci CRD/DTR/PAS sandbox support.

Status: requires app registration on Epic's side, plus the SMART launch handler from Phase 2. Not yet live.

## 5. Availity clearinghouse (Phase 3)

Availity's [developer portal](https://developer.availity.com/partner/gettingstarted) exposes an X12 278 Service Reviews API for prior authorization requests, with a free demo tier that returns canned responses via the `X-Api-Mock-Scenario-ID` header.

Status: outbound integration in progress. When live, the sandbox will optionally submit the same PAS request to Availity's clearinghouse endpoint in addition to the FHIR PAS path, mirroring how a large health system would route a 278 today.

## Confirming the sandbox is reachable

Cheap smoke test that everything is answering:

```bash
curl -s https://surakshith.com/cms-0057/api/cds-services | jq
curl -s https://surakshith.com/cms-0057/api/fhir/metadata | jq '.software, .fhirVersion'
curl -s https://surakshith.com/cms-0057/api/.well-known/smart-configuration | jq '.issuer, .token_endpoint'
```
