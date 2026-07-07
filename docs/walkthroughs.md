# Guided walkthroughs

## Prior Authorization API (`/ehr` + `/um`)

![CDS Hooks card for the MRI Brain order](screenshots/04-ehr-cds-card.png)

**Jane Doe (COMM-PPO)** is the baseline. `99214` returns an info card because the code is not on the PA list. `70553` (MRI Brain) returns a warning indicator, routes to Carelon, and offers the DTR launch. `J9035` (Avastin) with the oncology diagnosis preset returns a critical indicator also routed to Carelon, and the no-oncology-diagnosis variant keeps the same code but re-routes to BCBSIL, which is the conditional routing logic in `lib/routing.js`. Toggling hard-stop produces a non-overridable indicator that disables order-sign.

![DTR questionnaire with CQL pre-population](screenshots/05-ehr-dtr.png)

The DTR pane fetches the bound FHIR Questionnaire, renders `item[]` dynamically, and pre-populates answers marked with an SDC `initialExpression`. Submitting posts a PAS request Bundle (Patient + Coverage + Practitioner + Claim + QuestionnaireResponse, type `collection` with the PAS request-bundle profile). The response is a PAS response Bundle carrying a profiled ClaimResponse plus the Da Vinci CRD coverage-information Task.

![Approved PAS response in the EHR](screenshots/06-ehr-pas-approved.png)

For the pended path, switch to **Robert Chen (MA-PPO)** and order `15820` (blepharoplasty). The 2026 grids list that code on the Medicare Advantage list only, which is why the scenario runs under the MA plan. The EHR shows an amber pending state, and the determination finalizes on the first poll after the eight second review window elapses (`lib/pendedReview.js`). The feed shows the full sequence: `BUNDLE RECEIVED` → `PA PENDED` → `PA APPROVED (pended → finalized)` → `REST-HOOK NOTIFICATION`.

For the denial path, check **simulate denial** before submitting any PA-required order. The ClaimResponse returns `outcome: error` with a structured reason code (X12 AAA `A4`) and appeal language, which the operational provisions of the rule require of real denials.

**Dorothy Hayes (COMM-PPO)** has `27447` (TKA) pre-filled and demonstrates the gold-card exemption: Dr. Patel's NPI is enrolled in the Orthopedic Gold Card program, so PA is auto-satisfied. **Marcus Johnson (COMM-HMO)** demonstrates category-level matching, with an ABA order routed to Lucet.

## Patient Access API (`/patient`)

![Patient portal with coverage, claims, and history](screenshots/07-patient-portal.png)

The portal obtains a patient-scoped demo token, displays its decoded claims, and polls the Patient Access API with it. The response carries a US Core shaped Patient, a CARIN BB shaped Coverage, CARIN BB ExplanationOfBenefit resources with the three-part adjudication totals, and the member's PA event history. Selecting a different member re-fetches immediately.

## Provider Access API (`/um` Provider Access tab)

![Provider access panel with an attributed patient expanded](screenshots/09-provider-access.png)

The panel exchanges client credentials for a system-scoped token and retrieves the attributed patient panel for an NPI. The banner includes a **Try the API without a token** button, which surfaces the live 401 and its OperationOutcome, and a control that shows the decoded token claims.

## Payer-to-Payer API (`/um` P2P Exchange tab)

![P2P exchange with member match and prior plan history](screenshots/08-p2p-exchange.png)

Step 1 sends `POST /Patient/$member-match` with a Parameters body. Step 2 shows the pure Parameters response, and the client reads `MemberIdentifier.valueIdentifier.value` the way a production caller would. Step 3 fetches the prior plan history as a FHIR searchset Bundle: a cancelled prior Coverage, one ClaimResponse per prior authorization (including a denial carried in `error[]` with appeal rights in `processNote`), and CARIN BB EOBs. Jane Doe's prior payer is Aetna and Marcus Johnson's is Cigna, with different histories.

## Rule ingestion pipeline (`/um` Rules & Schema tab)

![Rules explorer with the MRI Brain rule](screenshots/02-um-rules-explorer.png)

The sandbox boots with the snapshot loaded, so the ingestion story starts from the **Reset to an empty index** link: upload one or more PA grid PDFs, watch the extraction land in a staging review with per-source metrics and a quality gate, then commit to the live CRD index. The Rules Explorer resolves any code or category against the committed index and shows routing, bound questionnaire, and provenance down to the source page.
