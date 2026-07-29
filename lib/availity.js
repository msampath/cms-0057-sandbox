/**
 * Availity Service Reviews API client.
 *
 * Availity is the largest US healthcare clearinghouse. Their Service
 * Reviews API is an X12 278 authorization/referral transaction wrapped in
 * a JSON envelope, with OAuth 2.0 client_credentials auth against
 * api.availity.com and a demo tier that returns canned scenarios via the
 * X-Api-Mock-Scenario-ID header.
 *
 * This module is the sandbox's outbound side to that API. It turns a PAS
 * FHIR Bundle into Availity's JSON shape, gets a token, and calls the
 * demo endpoint. If AVAILITY_CLIENT_ID + AVAILITY_CLIENT_SECRET are not
 * set the module returns a mock response, so the sandbox stays demoable
 * without credentials.
 *
 * Env:
 *   AVAILITY_CLIENT_ID       demo-tier client id
 *   AVAILITY_CLIENT_SECRET   demo-tier client secret
 *   AVAILITY_ENABLED=off     kill switch (overrides everything → returns 501)
 *   AVAILITY_MOCK=on         force mock even when credentials are present
 */

const TOKEN_ENDPOINT = 'https://api.availity.com/v1/token';
const DEMO_BASE = 'https://qua.api.availity.com/arp/ar-routing/external';
const DEMO_SCOPE = 'healthcare-hipaa-transactions-demo';

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
    scope: DEMO_SCOPE
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

/**
 * Project the PAS Bundle into Availity's Service Reviews request envelope.
 *
 * This is a small representative shape, not the full schema. Availity's
 * real schema carries envelope trading-partner IDs, submitter/receiver
 * identifiers, and roughly 30 fields. The mapping below matches the JSON
 * keys Availity documents for their sample requests, so a real client
 * built against this projection would only need to extend, not rewrite.
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

  return {
    payer: {
      id: 'BCBSIL',
      name: 'Blue Cross Blue Shield of Illinois'
    },
    provider: {
      npi: npi || '1234567890',
      lastName: practitioner?.name?.[0]?.family || 'UNKNOWN',
      firstName: practitioner?.name?.[0]?.given?.[0] || ''
    },
    subscriber: {
      memberId: coverage?.subscriberId || 'UNKNOWN'
    },
    patient: {
      firstName: patient?.name?.[0]?.given?.[0] || '',
      lastName: patient?.name?.[0]?.family || 'UNKNOWN',
      birthDate: patient?.birthDate || null,
      gender: patient?.gender || null
    },
    diagnoses: (patient?.condition || [])
      .map((c) => c?.code?.coding?.[0]?.code)
      .filter(Boolean),
    services: [
      {
        code: code || null,
        codeQualifier: code?.startsWith('J') ? 'HC:J' : 'HC',
        fromDate: date,
        toDate: date,
        placeOfService: '11',
        units: 1
      }
    ],
    requestCategory: 'AR',
    certificationType: 'I',
    scenarioId: opts.scenarioId || null
  };
}

function mockResponse(payload) {
  const code = payload?.services?.[0]?.code || 'UNKNOWN';
  return {
    _mock: true,
    _mockReason: availityMode(),
    controlNumber: 'MOCK' + Date.now().toString().slice(-8),
    certificationNumber: 'AUTH' + Math.floor(Math.random() * 9000000 + 1000000),
    status: 'A1',
    statusDescription: 'Certified in total',
    payer: payload.payer,
    subscriber: payload.subscriber,
    service: {
      code,
      certifiedUnits: payload?.services?.[0]?.units || 1
    },
    payerNote:
      'Demo response (Availity credentials not configured on the deployed sandbox). Set AVAILITY_CLIENT_ID and AVAILITY_CLIENT_SECRET on Cloud Run to see live Availity demo-tier canned responses.'
  };
}

/**
 * Submit a PAS Bundle to Availity's Service Reviews demo tier.
 *
 * Returns { request, response, mode } for the UI to display side by side
 * with the FHIR ClaimResponse.
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

  const res = await fetch(`${DEMO_BASE}/service-reviews`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request)
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _rawText: text };
  }
  if (!res.ok) {
    const err = new Error(`Availity Service Reviews error: ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return { request, response: json, mode: 'live' };
}
