/**
 * Availity Coverages API client (X12 270/271 eligibility check).
 *
 * Availity is the largest US healthcare clearinghouse. Their Coverages
 * API is an X12 270 eligibility inquiry wrapped in JSON, returning an
 * X12 271 eligibility response — active/inactive coverage plus
 * plan/benefit details for a given patient at a given payer.
 *
 * This module was originally built against Availity's Service Reviews
 * API (X12 278 prior authorization). We pivoted to Coverages because
 * the developer credentials we have are subscribed to the "Healthcare
 * HIPAA Transactions - Demo" product, which includes Coverages but not
 * Service Reviews.
 *
 * Empirically verified against the live sandbox on 2026-08-05:
 *   - Scope is `healthcare-hipaa-transactions-demo` (single, with
 *     -demo suffix) -- not the `healthcare-hipaa-transactions` /
 *     dual-scope variants Availity's own blog worked example implies.
 *     The dual scope returns `unauthorized_client`.
 *   - Both `/availity/v1/coverages` and `/v1/coverages` return the
 *     same response; we use the `/availity/` prefix to match
 *     Availity's own catalogue URL structure.
 *   - Demo-tier responses are SYNCHRONOUS (HTTP 200 with a fully
 *     populated `coverages[]` array), not async 202+poll like Service
 *     Reviews. No polling machinery is needed here.
 *   - Demo mode returns a canned patient (ZENA MARDIN) regardless of
 *     the submitted body -- Availity's sandbox does not vary its
 *     response by request content for this product.
 *
 * Env:
 *   AVAILITY_CLIENT_ID       client id
 *   AVAILITY_CLIENT_SECRET   client secret
 *   AVAILITY_ENABLED=off     kill switch (overrides everything → 501)
 *   AVAILITY_MOCK=on         force local mock even when credentials are set
 */

const TOKEN_ENDPOINT = 'https://api.availity.com/v1/token';
const COVERAGES_ENDPOINT = 'https://api.availity.com/availity/v1/coverages';
// See header comment: this exact scope string is what the token
// endpoint accepts for this subscription -- empirically verified,
// contradicts Availity's own published worked example.
const COVERAGES_SCOPE = 'healthcare-hipaa-transactions-demo';

let cachedToken = null;

export function availityEnabled() {
  return process.env.AVAILITY_ENABLED !== 'off';
}

function haveCredentials() {
  return Boolean(process.env.AVAILITY_CLIENT_ID && process.env.AVAILITY_CLIENT_SECRET);
}

export function availityMode() {
  if (!availityEnabled()) return 'disabled';
  if (process.env.AVAILITY_MOCK === 'on') return 'mock-forced';
  if (!haveCredentials()) return 'mock-no-credentials';
  return 'live';
}

async function getToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5000) {
    return cachedToken.accessToken;
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.AVAILITY_CLIENT_ID,
    client_secret: process.env.AVAILITY_CLIENT_SECRET,
    scope: COVERAGES_SCOPE
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Availity token error: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  cachedToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in || 300) * 1000
  };
  return cachedToken.accessToken;
}

function genderCode(fhirGender) {
  if (fhirGender === 'female') return 'F';
  if (fhirGender === 'male') return 'M';
  return 'U';
}

/**
 * Build the Coverages POST request body from one of this sandbox's demo
 * patients (lib/patients.js).
 *
 * Field names come from the Availity Coverages 1.0.0 request contract
 * (payerId, memberId, patientFirstName/LastName/BirthDate/Gender,
 * providerNpi/LastName, subscriberRelationship, serviceType, asOfDate).
 * The demo-tier sandbox does NOT vary its response by request content,
 * so simplifications like `payerId: 'BCBSIL'` (a display label rather
 * than Availity's internal payer code) and a fixed `serviceType: '30'`
 * (Health Benefit Plan Coverage, the generic eligibility catch-all)
 * are safe here but would need real values for a production call.
 */
export function patientToCoverageRequest(patient) {
  return {
    payerId: 'BCBSIL',
    providerNpi: patient?.npi || '1234567890',
    providerLastName: patient?.practitioner?.family || 'UNKNOWN',
    memberId: patient?.subscriberId || 'UNKNOWN',
    patientFirstName: patient?.given?.[0] || '',
    patientLastName: patient?.family || 'UNKNOWN',
    patientBirthDate: patient?.dob || null,
    patientGender: patient?.gender === 'female' ? 'Female' : patient?.gender === 'male' ? 'Male' : 'Unknown',
    patientGenderCode: genderCode(patient?.gender),
    patientState: 'IL', // BCBSIL -- all four demo patients are Illinois
    subscriberRelationship: 'Self',
    subscriberRelationshipCode: '18',
    serviceType: '30'
    // asOfDate deliberately omitted: Availity's demo sandbox is
    // populated with 2014-era data and returns HTTP 500 for any
    // "current" date. Omitting the field returns the canned demo
    // response cleanly. Add it back with a plan-effective date once
    // routing to a real payer.
  };
}

// Mirrors the real API's terminal Coverages response shape (empirically
// captured from Availity's demo sandbox) so the UI does not need
// mode-specific branching to read the result. Field names are the real
// ones (id, controlNumber, status, statusCode, coverages[]/subscriber/
// patient/payer/plans[]) not guesses.
function mockCoverageResponse(payload) {
  return {
    _mock: true,
    _mockReason: availityMode(),
    totalCount: 1,
    count: 1,
    coverages: [
      {
        id: 'MOCK' + Date.now().toString().slice(-8),
        controlNumber: 'MOCK-CTRL-' + Math.floor(Math.random() * 9000000 + 1000000),
        status: 'Complete',
        statusCode: '4',
        asOfDate: new Date().toISOString(),
        requestedServiceType: [{ code: '30', value: 'Health Benefit Plan Coverage' }],
        validationMessages: [],
        subscriber: {
          firstName: payload.patientFirstName,
          lastName: payload.patientLastName,
          memberId: payload.memberId,
          gender: payload.patientGender,
          genderCode: payload.patientGenderCode,
          birthDate: payload.patientBirthDate
        },
        patient: {
          firstName: payload.patientFirstName,
          lastName: payload.patientLastName,
          subscriberRelationship: payload.subscriberRelationship,
          subscriberRelationshipCode: payload.subscriberRelationshipCode,
          gender: payload.patientGender,
          genderCode: payload.patientGenderCode,
          birthDate: payload.patientBirthDate
        },
        payer: { name: 'Blue Cross Blue Shield of Illinois', payerId: payload.payerId },
        requestingProvider: { npi: payload.providerNpi, lastName: payload.providerLastName },
        plans: [{ status: 'Active Coverage', statusCode: '1' }]
      }
    ],
    payerNote:
      'Demo response (Availity credentials not configured on the deployed sandbox). Set AVAILITY_CLIENT_ID and AVAILITY_CLIENT_SECRET on Cloud Run to see live Availity demo-tier canned responses.'
  };
}

async function parseJsonSafe(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { _rawText: text };
  }
}

/**
 * Check patient coverage/eligibility via Availity's Coverages API.
 *
 * Returns { request, response, mode }. Demo-tier responses come back
 * synchronously in one round trip (verified 2026-08-05) so no polling
 * needed. Live-mode responses use Availity's canned demo patient (ZENA
 * MARDIN) regardless of what we send.
 */
export async function checkCoverage(patient, opts = {}) {
  if (!availityEnabled()) {
    const err = new Error('Availity integration disabled (AVAILITY_ENABLED=off)');
    err.status = 501;
    throw err;
  }

  const request = patientToCoverageRequest(patient);
  const mode = availityMode();

  if (mode !== 'live') {
    return { request, response: mockCoverageResponse(request), mode };
  }

  const token = await getToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    'X-Client-Id': process.env.AVAILITY_CLIENT_ID,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
  if (opts.scenarioId) {
    headers['X-Api-Mock-Scenario-ID'] = opts.scenarioId;
  }

  const res = await fetch(COVERAGES_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(request)
  });
  const json = await parseJsonSafe(res);
  if (!res.ok) {
    const err = new Error(`Availity Coverages error: ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  return { request, response: json, mode: 'live' };
}
