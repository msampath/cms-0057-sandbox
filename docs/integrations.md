# External integrations

The sandbox is reachable from public health-IT test tools. Every API endpoint sends `Access-Control-Allow-Origin: *`, so browser-based sandboxes can call it directly. The three access APIs still enforce SMART Bearer tokens on top of that.

Base URL for everything below: `https://surakshith.com/cms-0057`.

## Quick reference

| Integration | Side | Signup needed | Verified end to end |
|---|---|---|---|
| [CDS Hooks Sandbox](#1-cds-hooks-sandbox) | EHR-facing (inbound) | No | Direct URL registration |
| [Inferno by ONC](#2-inferno-by-onc) | Conformance oracle | No | Run test kit against live URL |
| [SMART App Launcher](#3-smart-app-launcher) | EHR-facing (inbound) | No | Yes, provider-EHR launch |
| [Epic on FHIR](#4-epic-on-fhir) | EHR-facing (inbound) | Yes | Registered, OAuth accepts client; live launch limited by Epic sandbox |
| [Availity](#5-availity-clearinghouse) | Clearinghouse (outbound) | Yes for live mode | Mock mode verified, live mode needs credentials |

## Setup order, quickest first

1. **CDS Hooks Sandbox** — no signup. Paste `https://surakshith.com/cms-0057/api/cds-services` into their Services config. Done in about a minute.
2. **SMART App Launcher** — no signup. Paste `https://surakshith.com/cms-0057/ehr/launch` into the App Launch URL field and click Launch. Done in about a minute.
3. **Inferno by ONC** — no signup, but running the PAS test kit takes a few minutes to configure and execute.
4. **Availity mock mode** — already live at `/ehr` on every PAS submission. Nothing to do.
5. **Availity live mode** — sign up at [developer.availity.com](https://developer.availity.com/partner/gettingstarted), create demo app, set `AVAILITY_CLIENT_ID` and `AVAILITY_CLIENT_SECRET` on Cloud Run. Roughly 30 minutes end to end because of MFA setup and app registration.
6. **Epic on FHIR** — already registered (see Section 4). No further work unless the app is deleted or Epic changes their sandbox model to expose a self-serve EHR launcher for CMS Prior Auth apps.

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

## 3. SMART App Launcher

The reference [SMART App Launcher](https://launch.smarthealthit.org) acts as an EHR opening the sandbox's `/ehr` surface as a SMART on FHIR app. This is the reference open-source SMART launcher and the same one Epic and Cerner test against.

Setup:

1. Open [launch.smarthealthit.org](https://launch.smarthealthit.org)
2. Leave defaults (Provider EHR Launch, R4)
3. App Launch URL: `https://surakshith.com/cms-0057/ehr/launch`
4. Click **Launch**, pick any practitioner and any patient
5. The sandbox `/ehr` opens with an emerald banner reading "Launched from launch.smarthealthit.org · Patient/<uuid>" followed by the launched patient's name, DOB, and gender

Under the hood:

- `/ehr/launch` discovers `{iss}/.well-known/smart-configuration`, generates a PKCE verifier + `state`, and redirects the browser to the EHR's authorize endpoint
- `/ehr/callback` exchanges the returned `code` at the token endpoint, stashes the access token and launched patient ID in sessionStorage, and hands off to `/ehr`
- `/ehr` reads the sessionStorage, fetches `Patient/<id>` from the launching EHR with the Bearer token, and displays the banner

Public client, PKCE, no secret. Same shape works against any conformant SMART v2 EHR sandbox including Epic.

## 4. Epic on FHIR

Registered at [fhir.epic.com](https://fhir.epic.com) under the developer account `msampath`, non-production client id issued (`cfb74462-c737-433c-9ceb-b484c4e08261`).

App configuration:

- Application Audience: **Clinicians or Administrative Users**
- Use Case: **CMS Prior Auth**
- App Launch URL: `https://surakshith.com/cms-0057/ehr/launch`
- Redirect URI: `https://surakshith.com/cms-0057/ehr/callback`
- Incoming APIs: Patient.Read (Demographics), Coverage.Read (Patient Insurance Information), Encounter.Read (Patient Chart)
- Outgoing APIs: CDS Hooks Framework, CRD Request
- Endpoint URI (Epic's outbound target for CDS Hooks): `https://surakshith.com/cms-0057/api/cds-services`
- SMART v1 scopes, R4, PKCE public client

The client id lookup in `app/ehr/launch/page.jsx` keys on the launching FHIR server's host, so the same code path serves both `launch.smarthealthit.org` and `fhir.epic.com` without a runtime switch.

### What is verified

- **Registration accepted.** Epic issued the client id. The app appears in the developer account's non-production apps list.
- **OAuth authorize call reaches Epic.** Hitting `/ehr/launch?iss=https://fhir.epic.com/...&launch=<code>` correctly discovers Epic's SMART configuration and redirects the browser to `https://fhir.epic.com/interconnect-fhir-oauth/oauth2/authorize` with the Epic client id and this app's redirect URI. Epic accepts the request rather than rejecting the client, which confirms the registration is correctly wired.

### What actually works against Epic's public sandbox

- **Client registration.** Accepted. Non-production client id issued.
- **OAuth authorize call.** Reaches Epic. Client id validated, redirect URI validated, ticket generated. Verified against `https://surakshith.com/cms-0057/ehr/standalone`.
- **Login and patient selection.** **Does not proceed.** Epic silently strips all resource scopes for our app (regardless of whether we send `patient/*.read`, `user/*.read`, or nothing) and then returns "Invalid OAuth 2.0 request." at the Hyperspace login gateway.

The reason is that our app registration uses **CMS Prior Auth** as the use case, which Epic intends for backend CRD/DTR/PAS flows. Epic's public sandbox does not grant standalone browser-facing scopes to CMS Prior Auth apps because the real testing model for those flows is backend-to-backend against a customer Epic install.

A separate Epic app registered under **General** use case would likely allow standalone reads. That would require a new registration and a new client id, since the current app is marked Ready for Production and cannot be edited.

**Working alternative for the launched-from-a-real-EHR demo beat:** the SMART App Launcher (Section 3) uses exactly the same code path, same PKCE public client flow, same `/ehr` banner, tested end to end against `launch.smarthealthit.org` with a real test patient (Geoffrey Abbott shown in the case study).

### LaunchPad, mentioned but not usable here

Epic exposes a tool called **LaunchPad** under Documentation → SMART on FHIR (OAuth 2.0) → Try It. It is a lightweight harness for firing an EHR launch at a registered app. Subject to the same use-case restriction as standalone — LaunchPad against our CMS Prior Auth app hits the same Epic policy wall. LaunchPad is useful for General-use-case apps.

### Notes

- Epic caches registered API changes for up to 30 minutes. A 403 immediately after registering new scopes usually clears itself with a wait.
- The Epic sandbox refreshes every Sunday at 8:00 PM Central. Any data written the prior week is wiped, and there may be intermittent errors around that time.
- The Epic app is currently marked Ready for Production, which locks it from further edits. Adding new scopes or APIs would require a new app registration and a new client id.

## 5. Availity clearinghouse

Availity's [developer portal](https://developer.availity.com/partner/gettingstarted) exposes an X12 278 Service Reviews API for prior authorization requests, with a free demo tier that returns canned responses via the `X-Api-Mock-Scenario-ID` header.

Every PAS submission from `/ehr` now fans out in parallel: the FHIR PAS Bundle goes to the sandbox's own payer endpoint, and the same Bundle is projected to Availity's JSON envelope and posted to their Service Reviews API. The approved PA card and the Availity certified card appear side by side in the EHR.

Mode indicator on each response:

- `live` — real HTTP call to `qua.api.availity.com/arp/ar-routing/external`, credentials configured
- `mock-no-credentials` — canned local response; no outbound call made because `AVAILITY_CLIENT_ID` / `AVAILITY_CLIENT_SECRET` are not set
- `mock-forced` — canned response even though credentials are present (`AVAILITY_MOCK=on`)
- `disabled` — `AVAILITY_ENABLED=off`, integration returns 501

Enabling live mode:

1. [Sign up at developer.availity.com](https://developer.availity.com/partner/gettingstarted)
2. Complete email verification and MFA
3. Create an organization, then a Demo-plan application
4. Subscribe the app to the Service Reviews API (Demo subscriptions are auto-approved)
5. Copy the client_id and client_secret
6. Set `AVAILITY_CLIENT_ID`, `AVAILITY_CLIENT_SECRET` on Cloud Run:
   ```powershell
   gcloud run services update cms-0057-demo --region us-central1 `
     --update-env-vars AVAILITY_CLIENT_ID=<id>,AVAILITY_CLIENT_SECRET=<secret>
   ```

The projection module is at `lib/availity.js` and the outbound endpoint is `app/api/availity/service-review/route.js`. Requests are logged to the UM transaction feed with actor `AVAILITY`.

## Confirming the sandbox is reachable

Cheap smoke test that everything is answering:

```bash
curl -s https://surakshith.com/cms-0057/api/cds-services | jq
curl -s https://surakshith.com/cms-0057/api/fhir/metadata | jq '.software, .fhirVersion'
curl -s https://surakshith.com/cms-0057/api/.well-known/smart-configuration | jq '.issuer, .token_endpoint'
```
