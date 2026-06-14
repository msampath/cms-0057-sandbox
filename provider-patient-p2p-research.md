# Research Plan — Provider Access, Patient Access, Payer-to-Payer APIs

Three of the four CMS-0057-F mandated FHIR APIs are not yet represented in this demo. This document is a research plan and scoping note before building them. The goal is self-contained implementations that use the existing demo data (patient scenarios, transaction log, rule index) as the backing store — no new external dependencies.

---

## API 1 — Provider Access API

### What the rule says
45 CFR 156.221(b) (QHP issuers) and the parallel Medicaid/CHIP provisions require payers to expose a FHIR R4 endpoint that contracted providers can query to retrieve their attributed patients' claims, clinical data, and prior authorization decisions. Effective Jan 1, 2027.

The spec references: Da Vinci PDex IG (Payer Data Exchange), US Core STU 3.1.1 profiles, and Da Vinci Plan Net for directory data. The queries are provider-authenticated via SMART on FHIR v2.

### What this covers
- A provider queries by their NPI and receives, for each attributed patient: current coverage, PA decisions (open, approved, pended, denied), formulary placement, and the clinical note that accompanied the authorization.
- The provider does not need to know the patient is a member — the payer surfaces the panel.

### Open research questions
1. Which Da Vinci PDex IG version applies? (PDex STU 2.0 is the current; the rule references it but enforcement language needs checking — does it require PDex or just US Core-aligned claims?)
2. Is the $everything operation required, or can the provider query individual resource types (Claim, ExplanationOfBenefit, ClaimResponse)?
3. What is the exact SMART on FHIR scope for provider-facing access? (`system/Patient.read`, `system/ExplanationOfBenefit.read`, `system/ClaimResponse.read`?)
4. Does provider access include prior authorization history from the full benefit year, or just open/recent decisions?
5. What attribution mechanism is required — does the payer build the panel from claims history, or does the provider submit an explicit patient list?

### Self-contained demo approach
- New API route: `GET /api/provider-access?npi={npi}` → returns all transaction log entries where the CRD hook's practitioner NPI matches, grouped by patient (patientId, name, plan, PA decisions).
- Seed data: the four existing patient scenarios map to specific NPIs in the EHR surface. Jane/Robert/Dorothy/Marcus each have a practitioner NPI in the CDS hook payload; these become the attribution links.
- New tab in `/um` — "Provider Access": NPI lookup field, patient panel grid with one row per patient showing PA status, last decision date, auth number if any.
- No real SMART authentication — similar to the existing EHR demo, authentication is simulated.

### Files to create / modify
- `app/api/provider-access/route.js` — new
- `app/um/providerAccess.jsx` — new panel component
- `app/um/page.jsx` — add `'provider'` to tab state, import panel, wire up tab button
- `lib/db.js` — no change needed (transaction log is already accessible)

---

## API 2 — Patient Access API

### What the rule says
45 CFR 156.221(a) (QHP issuers), 156.226 (Medicaid), and companion provisions require payers to expose a FHIR R4 endpoint that allows patients and their apps to retrieve their own claims, prior authorizations, coverage, and clinical data. Effective Jan 1, 2027 (PA data specifically — some clinical data requirements were already in place under prior rules).

The spec references: Da Vinci PDex IG, US Core STU 3.1.1, SMART on FHIR v2 (patient launch). The patient authenticates with the payer's identity portal and authorizes a third-party app (e.g., Apple Health, CommonHealth) to retrieve their data.

### What this covers
- A patient queries their own data: coverage details (plan name, benefit year, cost sharing), claims and EOBs, PA decisions (what was requested, what was approved/denied, appeal rights if denied), and clinical notes associated with their authorizations.
- The USCDI on FHIR layer (US Core profiles) overlaps significantly — clinical data like conditions, medications, allergies may already be present from the EHR's record.

### Open research questions
1. Does the final rule specify ExplanationOfBenefit (EOB) as mandatory, or is ClaimResponse sufficient for PA-specific data? (CARIN Blue Button uses EOB; Da Vinci PDex uses it too — but is it mandated for PA-only flows?)
2. Is the CARIN IG for Blue Button® required alongside PDex, or is PDex alone sufficient? (CARIN BB2.0 is the claims data IG; PDex is the broader payer exchange IG. The rule may require both.)
3. What is the patient-facing SMART on FHIR scope? (`patient/Patient.read`, `patient/Coverage.read`, `patient/ExplanationOfBenefit.read`?)
4. What specifically must be surfaced for a denied PA — is appeal rights text (as we have in the denial ClaimResponse) sufficient, or is there a specific data structure required?
5. Does prior authorization data need to be accessible indefinitely, or is there a lookback period specified in the rule?

### Self-contained demo approach
- New surface: `/patient` page — patient selects themselves from a dropdown (Jane / Robert / Dorothy / Marcus), sees their coverage card, PA history from the transaction log, and any open/resolved PA requests from the pending map.
- New API routes: `GET /api/patient-access?patientId={id}` → returns patient demographics, coverage details from the scenario, and all transaction log entries for that patient.
- For denied requests, the existing denial reason codes and appeal rights text from the ClaimResponse are surfaced directly.
- No SMART login — patient selects themselves from the dropdown, same pattern as the EHR scenario picker.

### Files to create / modify
- `app/patient/page.jsx` — new page (new browser surface alongside `/ehr` and `/um`)
- `app/api/patient-access/route.js` — new
- No changes to lib/db.js or existing surfaces needed

---

## API 3 — Payer-to-Payer API

### What the rule says
45 CFR 156.221(c) (QHP issuers) and parallel Medicaid provisions require payers to send a departing member's clinical data and PA history to the member's new plan upon enrollment, with the member's consent. The new payer may request up to five years of prior data from the old payer. Effective Jan 1, 2027.

The spec references: Da Vinci PDex IG (the `$member-match` operation + bulk FHIR export), US Core STU 3.1.1 clinical profiles, and the Da Vinci Data Exchange for Quality Measures IG for measure-linked data. The $member-match FHIR operation is defined in the PDex IG and uses a Coverage and Patient resource to locate a member in the old payer's system.

### What this covers
- Member enrolls with BCBSIL. Their prior plan (e.g., Aetna) holds PA history, EOBs, and clinical notes.
- BCBSIL POSTs a `$member-match` request to Aetna's FHIR server with a Coverage resource and patient demographics.
- Aetna matches the member, authorizes the exchange (with the member's consent on file), and returns a FHIR Parameters response with the matched member ID.
- BCBSIL uses that ID to request a bulk FHIR export (`$export` on Group/<matched-member-group>`) — clinical history, EOBs, PA records.
- BCBSIL ingests the bundle and makes it available in the member's record going forward.

### Open research questions
1. Is the $member-match operation exactly as defined in PDex STU 2.0, or did the final rule introduce variations? (PDex defines it as `POST /Patient/$member-match` with a Parameters body containing `MemberPatient` and `CoverageToMatch` — confirm this is what CMS mandates.)
2. Is bulk FHIR ($export) required, or can individual resource queries suffice? (Bulk FHIR is the practical path for large member histories, but individual queries may be acceptable for the mandate.)
3. What is the consent mechanism? The rule requires member consent for the data exchange — is this captured in a FHIR Consent resource, or is an out-of-band consent (enrollment form) sufficient?
4. What is the "prior payer data" scope — all claims and PA decisions, or clinical data too? (The five-year lookback suggests comprehensive clinical history, not just PA records.)
5. How does the mandate interact with TPO (Treatment, Payment, Operations) carve-outs under HIPAA? Some clinical notes may be restricted regardless of consent.
6. Is the new payer required to initiate the request, or can the old payer push proactively? (The rule implies the new payer requests — old payer responds — but push-on-disenrollment is an implementation pattern worth checking.)

### Self-contained demo approach
- Seed each patient scenario with a "prior plan" block (prior payer name, plan ID, prior PA history for the last 12 months, prior EOB summaries).
- New API routes:
  - `POST /api/payer-to-payer/member-match` → accepts a Coverage + Patient body, returns a matched member reference from the seeded prior-plan data.
  - `GET /api/payer-to-payer/history/{patientId}` → returns the seeded prior plan data (prior PA decisions, EOB summaries) for that patient.
- New tab in `/um` — "P2P Exchange": shows a member enrollment event, the $member-match Parameters body sent to the prior payer, the matched response, and the clinical history received.
- The "prior payer" is simulated — the endpoint accepts the request and returns from the seed data without any real external call.

### Files to create / modify
- `app/api/payer-to-payer/member-match/route.js` — new
- `app/api/payer-to-payer/history/[patientId]/route.js` — new
- `app/um/p2pExchange.jsx` — new panel component
- `app/um/page.jsx` — add `'p2p'` tab
- `lib/db.js` — add seeded prior-plan history to each patient scenario (or add a separate `priorPlanHistory` constant in db.js)

---

## Cross-cutting concerns to resolve before building

1. **SMART on FHIR** — all three APIs require member or provider authentication in production. The demo should clearly label where SMART would intercept and what scopes would be required, without actually implementing the OAuth flow (consistent with how the EHR demo handles it today).

2. **NPI linkage** — the transaction log currently records CRD events with actor strings ("CRD Engine", "PAS Gateway") but not the practitioner NPI from the CDS hook payload. Provider Access needs NPI in the log. The CDS hook payload (`prefetch.practitioner`) carries the NPI — this needs to be extracted and logged in `app/api/cds-services/order-sign/route.js`.

3. **Patient ID consistency** — patient IDs in the EHR scenarios need to be stable and match across the transaction log, provider access panel, and patient access surface. Currently `patient.id` flows from the FHIR bundle — confirm all four scenarios produce consistent IDs.

4. **Prior plan seed data** — Payer-to-Payer needs realistic prior-plan history. The simplest approach: a static `priorHistory` map keyed by patient ID with a prior payer name, plan ID, and two or three example prior PA decisions (including one denial and one approval). This goes in `lib/db.js` alongside the existing defaultData.

5. **Tab navigation** — the `/um` page currently has two tabs ('rules', 'feed'). Adding 'provider' and 'p2p' tabs would bring it to four. Confirm the tab bar doesn't overflow on smaller screens; if it does, consider a dropdown or a second row.

---

## Implementation order recommendation

1. NPI logging fix (unblocks Provider Access)
2. Provider Access API + tab (uses existing log, simplest data model)
3. Patient Access page (new /patient surface, uses log + scenario seed data)
4. Payer-to-Payer tab (most mock-heavy, needs prior plan seed data)

The three together complete the CMS-0057-F four-API picture. The Prior Authorization API (CRD→DTR→PAS) is already represented.
