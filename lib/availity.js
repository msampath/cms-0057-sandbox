/**
 * Availity Service Reviews API client.
 *
 * Availity is the largest US healthcare clearinghouse. Their Service
 * Reviews API is an X12 278 authorization/referral transaction wrapped in
 * a JSON envelope, with OAuth 2.0 client_credentials auth against
 * api.availity.com.
 *
 * This module is the sandbox's outbound side to that API. It turns a PAS
 * FHIR Bundle into Availity's JSON shape, gets a token, and calls the
 * endpoint. If AVAILITY_CLIENT_ID + AVAILITY_CLIENT_SECRET are not set the
 * module returns a mock response, so the sandbox stays demoable without
 * credentials.
 *
 * Service Reviews is genuinely asynchronous: POST returns 202 with a
 * partial "Building Request" object and a Location poll URL, not an
 * immediate determination. Demo/mock behavior is not a separate scope or
 * host -- it's the same production-scoped endpoint, triggered per request
 * via the X-Api-Mock-Scenario-ID header. This module does a short bounded
 * poll inside the same request (a few GETs with brief waits) rather than
 * a background timer, matching the same reasoning lib/pendedReview.js
 * documents for the PAS pended flow: Cloud Run only allocates CPU while a
 * request is in flight, so anything that "waits" has to be either inside
 * one request or resolved lazily on a later one. If Availity still hasn't
 * resolved after that window, the response is returned honestly as
 * pending rather than a fabricated final result.
 *
 * Env:
 *   AVAILITY_CLIENT_ID       client id
 *   AVAILITY_CLIENT_SECRET   client secret
 *   AVAILITY_ENABLED=off     kill switch (overrides everything → returns 501)
 *   AVAILITY_MOCK=on         force mock even when credentials are present
 */

const TOKEN_ENDPOINT = 'https://api.availity.com/v1/token';
const SERVICE_REVIEWS_ENDPOINT = 'https://api.availity.com/availity/v2/service-reviews';
// Product "Healthcare HIPAA Transactions" (not the "-Demo" product, which
// does not include Service Reviews in its API list). Verified against
// Availity's own product catalogue and the Service Reviews 2.0.0 reference
// page, both consistently using this scope and this host+path.
const SERVICE_REVIEWS_SCOPE = 'healthcare-hipaa-transactions';

const POLL_ATTEMPTS = 4;
const POLL_DELAY_MS = 1500;

let cachedToken = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A review is terminal once the payer has actually decided, per the
// documented status/statusCode table (A1 Certified in Total, A2 Certified
// - Partial, A3 Not Certified, CT Contact Payer, NA No Action Required).
// A4 (Pending), 0/BR (Building Request), and A6 (Modified) mean "keep
// polling" -- Availity is still talking to the payer.
const TERMINAL_STATUS_CODES = new Set(['A1', 'A2', 'A3', 'CT', 'NA', '51', '71', 'C']);

function isTerminal(json) {
  return TERMINAL_STATUS_CODES.has(json?.statusCode);
}

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
    scope: SERVICE_REVIEWS_SCOPE
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

function pickEntry(bundle, resourceType) {
  return bundle?.entry?.find((e) => e?.resource?.resourceType === resourceType)?.resource;
}

function genderCode(fhirGender) {
  if (fhirGender === 'female') return 'F';
  if (fhirGender === 'male') return 'M';
  return 'U';
}

/**
 * Project the PAS Bundle into Availity's Service Reviews POST request
 * body, using the field names documented on the Service Reviews 2.0.0
 * reference page (requestingProvider, subscriber, patient, diagnoses,
 * requestTypeCode, serviceTypeCode, renderingProviders, etc.) rather than
 * an invented shape.
 *
 * Two simplifications, both deliberate: `payer.id` uses 'BCBSIL' as a
 * label rather than Availity's actual internal payer code for BCBSIL
 * (would need the Payer List API to resolve), and `serviceTypeCode`
 * defaults to '1' (Medical Care) rather than mapping each CPT/HCPCS/J-code
 * to its correct ASC X12 External Code Source 934 service type. Neither
 * matters for demo-scenario testing -- Availity's own docs state the
 * canned response does not change based on request content when
 * X-Api-Mock-Scenario-ID is set -- but would need real values before this
 * could route to an actual payer.
 */
export function bundleToAvailityRequest(bundle, opts = {}) {
  const patient = pickEntry(bundle, 'Patient');
  const coverage = pickEntry(bundle, 'Coverage');
  const practitioner = pickEntry(bundle, 'Practitioner');
  const claim = pickEntry(bundle, 'Claim');
  const item = claim?.item?.[0];
  const code = item?.productOrService?.coding?.[0]?.code;
  const date = claim?.servicedDate || new Date().toISOString().slice(0, 10);
  const npi = practitioner?.identifier?.find((i) => /npi/i.test(i.system || ''))?.value;
  const providerLastName = practitioner?.name?.[0]?.family || 'UNKNOWN';
  const providerFirstName = practitioner?.name?.[0]?.given?.[0] || '';

  return {
    payer: { id: 'BCBSIL', name: 'Blue Cross Blue Shield of Illinois' },
    requestingProvider: {
      npi: npi || '1234567890',
      lastName: providerLastName,
      firstName: providerFirstName
    },
    subscriber: { memberId: coverage?.subscriberId || 'UNKNOWN' },
    patient: {
      firstName: patient?.name?.[0]?.given?.[0] || '',
      lastName: patient?.name?.[0]?.family || 'UNKNOWN',
      birthDate: patient?.birthDate || null,
      gender: patient?.gender === 'female' ? 'Female' : patient?.gender === 'male' ? 'Male' : 'Unknown',
      genderCode: genderCode(patient?.gender),
      subscriberRelationshipCode: '18' // Self -- this sandbox's demo patients are all subscribers
    },
    diagnoses: (patient?.condition || [])
      .map((c) => c?.code?.coding?.[0]?.code)
      .filter(Boolean)
      .map((dxCode) => ({ qualifierCode: 'ABK', code: dxCode })),
    requestTypeCode: 'HS', // outpatient -- this sandbox has no inpatient/admission orders
    serviceTypeCode: '1',
    placeOfServiceCode: '11', // Office
    fromDate: date,
    toDate: date,
    quantity: '1',
    quantityTypeCode: 'UN',
    procedures: [
      {
        qualifierCode: 'HC', // HCPCS, per the documented sample requests
        code: code || null,
        fromDate: date,
        toDate: date
      }
    ],
    renderingProviders: [
      {
        lastName: providerLastName,
        firstName: providerFirstName,
        npi: npi || '1234567890',
        roleCode: 'SJ' // Service Provider
      }
    ]
  };
}

// Mirrors the real API's terminal ("Certified in Total") shape -- same
// field names (status, statusCode, certificationNumber) documented on the
// Service Reviews reference page -- so the UI does not need mode-specific
// branching to read the result.
function mockResponse(payload) {
  const code = payload?.procedures?.[0]?.code || 'UNKNOWN';
  return {
    _mock: true,
    _mockReason: availityMode(),
    controlNumber: 'MOCK' + Date.now().toString().slice(-8),
    certificationNumber: 'AUTH' + Math.floor(Math.random() * 9000000 + 1000000),
    status: 'Certified in Total',
    statusCode: 'A1',
    payer: payload.payer,
    subscriber: payload.subscriber,
    procedures: [{ code, status: 'Certified in Total', statusCode: 'A1' }],
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

// Poll the Location URL Availity hands back from the POST, a few times
// with brief waits, looking for a terminal status. Returns whatever the
// last GET returned -- terminal or not -- so the caller can tell the two
// apart via isTerminal() rather than this function silently deciding.
async function pollUntilTerminal(pollUrl, headers) {
  let latest = null;
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_DELAY_MS);
    const res = await fetch(pollUrl, { headers });
    latest = await parseJsonSafe(res);
    if (!res.ok) {
      const err = new Error(`Availity Service Reviews poll error: ${res.status}`);
      err.status = res.status;
      err.body = latest;
      throw err;
    }
    if (isTerminal(latest)) return latest;
  }
  return latest;
}

/**
 * Submit a PAS Bundle to Availity's Service Reviews API.
 *
 * Returns { request, response, mode } for the UI to display side by side
 * with the FHIR ClaimResponse. In live mode, response carries either a
 * terminal determination or, if Availity hasn't decided within the poll
 * window, response.pending === true plus response.pollUrl -- callers must
 * check for that rather than assuming every live response is final.
 */
export async function submitServiceReview(bundle, opts = {}) {
  if (!availityEnabled()) {
    const err = new Error('Availity integration disabled (AVAILITY_ENABLED=off)');
    err.status = 501;
    throw err;
  }

  const request = bundleToAvailityRequest(bundle, opts);
  const mode = availityMode();

  if (mode !== 'live') {
    return { request, response: mockResponse(request), mode };
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

  const res = await fetch(SERVICE_REVIEWS_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(request)
  });
  let json = await parseJsonSafe(res);
  if (!res.ok) {
    const err = new Error(`Availity Service Reviews error: ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  // 202 (or a 200 that still isn't a terminal statusCode) means Availity
  // is still talking to the payer. Poll a short, bounded number of times
  // rather than either hanging or lying about a result.
  if (!isTerminal(json)) {
    const pollUrl = json?.links?.self?.href || res.headers.get('location');
    if (pollUrl) {
      // GET requests carry no body and use the read-oriented Accept
      // header only -- Content-Type on a bodyless GET is meaningless and
      // some servers reject it.
      const pollHeaders = { Authorization: headers.Authorization, Accept: 'application/json' };
      if (opts.scenarioId) pollHeaders['X-Api-Mock-Scenario-ID'] = opts.scenarioId;
      json = await pollUntilTerminal(pollUrl, pollHeaders);
    }
    if (!isTerminal(json)) {
      json = { ...json, pending: true, pollUrl };
    }
  }

  return { request, response: json, mode: 'live' };
}
