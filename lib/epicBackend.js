import crypto from 'crypto';
import { keysAvailable, getKid, signRs384 } from '@/lib/keys';

/**
 * Epic Backend Services (SMART client-confidential-asymmetric) client.
 *
 * A second outbound integration alongside lib/availity.js — same four-mode
 * gating shape, but this one talks to Epic's public FHIR sandbox rather
 * than a clearinghouse. It reads Epic's well-known test patients using a
 * real OAuth2 client_credentials flow with an RS384-signed JWT client
 * assertion (SMART Backend Services), instead of a client secret.
 *
 * The assertion is signed with the same RS384 keypair lib/keys.js publishes
 * at the sandbox's own JWKS endpoint — Epic (or any verifier) only needs to
 * fetch one public key to validate both this assertion and this sandbox's
 * own demo tokens.
 *
 * Env:
 *   EPIC_BACKEND_CLIENT_ID    the client_id registered with Epic's App
 *                             Orchard for this sandbox (also used as iss/sub)
 *   EPIC_BACKEND_ENABLED=off  kill switch (overrides everything → 501)
 *   EPIC_BACKEND_MOCK=on      force mock even when a client id + keys exist
 *
 * Without EPIC_BACKEND_CLIENT_ID (or without the RS384 keypair from
 * lib/keys.js), the module returns a canned Patient resource for the
 * requested Epic test patient id, so the demo stays usable with zero
 * credentials.
 */

const EPIC_TOKEN_ENDPOINT = 'https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token';
const EPIC_FHIR_BASE = 'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4';
const DEFAULT_EPIC_SCOPES = 'system/Patient.read';

// Bundle-fetch requires Condition + Observation scopes on top of the
// baseline Patient.read. Kept as a separate constant so the caller can
// pick the narrow token for one-patient reads and the wider one only
// when the CQL bundle is being assembled.
const DEFAULT_EPIC_BUNDLE_SCOPES = 'system/Patient.read system/Condition.read system/Observation.read';

function epicScopes({ bundle = false } = {}) {
  const envKey = bundle ? 'EPIC_BACKEND_BUNDLE_SCOPES' : 'EPIC_BACKEND_SCOPES';
  return (
    process.env[envKey] ||
    (bundle ? DEFAULT_EPIC_BUNDLE_SCOPES : DEFAULT_EPIC_SCOPES)
  );
}

// Keyed by scope string so a token requested for a narrower scope set
// does not accidentally shadow one for a wider set (or vice versa).
const tokenCache = new Map();
const tokenInflight = new Map();
const OUTBOUND_TIMEOUT_MS = 15000;
// An upstream 401 or 403 is this server's credential problem, not the
// caller's. A 401 also drops the cached tokens so the next call gets new ones.
function upstreamStatus(status) {
  if (status === 401) tokenCache.clear();
  return status === 401 || status === 403 ? 502 : status;
}

// Upstream path segments must be plain ids. encodeURIComponent leaves . and
// .. alone, which would climb the path on the upstream host.
function pathSegment(value, name) {
  const v = String(value ?? '');
  if (!/^[A-Za-z0-9._~-]{1,128}$/.test(v) || v === '.' || v === '..') {
    const err = new Error(`${name} is not a valid id`);
    err.status = 400;
    throw err;
  }
  return encodeURIComponent(v);
}


export function epicBackendEnabled() {
  return process.env.EPIC_BACKEND_ENABLED !== 'off';
}

function haveCredentials() {
  return Boolean(process.env.EPIC_BACKEND_CLIENT_ID) && keysAvailable();
}

export function epicBackendMode() {
  if (!epicBackendEnabled()) return 'disabled';
  if (process.env.EPIC_BACKEND_MOCK === 'on') return 'mock-forced';
  if (!haveCredentials()) return 'mock-no-credentials';
  return 'live';
}

// Build the RS384-signed JWT client assertion per the SMART Backend
// Services / client-confidential-asymmetric profile. RS256 is explicitly
// not allowed by the spec — RS384 (matching lib/keys.js) is required.
function buildClientAssertion() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS384', typ: 'JWT', kid: getKid() };
  const claims = {
    iss: process.env.EPIC_BACKEND_CLIENT_ID,
    sub: process.env.EPIC_BACKEND_CLIENT_ID,
    aud: EPIC_TOKEN_ENDPOINT,
    jti: crypto.randomUUID(),
    exp: now + 240 // spec ceiling is 5 minutes; stay comfortably under it
  };
  const signingInput =
    Buffer.from(JSON.stringify(header)).toString('base64url') +
    '.' +
    Buffer.from(JSON.stringify(claims)).toString('base64url');
  return { jwt: `${signingInput}.${signRs384(signingInput)}`, claims };
}

// Returns { accessToken, claims } where `claims` are the JWT claims of
// the assertion that authorized this token -- on a cache hit those are
// the claims from the assertion sent to Epic when the token was minted,
// on a cache miss they are the claims sent just now. Either way the
// returned claims accurately describe the token's provenance, so
// callers wanting to show "what did we send to Epic" get a truthful
// answer.
async function getToken(scope = DEFAULT_EPIC_SCOPES) {
  const cached = tokenCache.get(scope);
  if (cached && cached.expiresAt > Date.now() + 5000) {
    return { accessToken: cached.accessToken, claims: cached.claims };
  }
  if (!tokenInflight.has(scope)) {
    tokenInflight.set(scope, fetchToken(scope).finally(() => tokenInflight.delete(scope)));
  }
  return tokenInflight.get(scope);
}

async function fetchToken(scope) {
  const { jwt, claims } = buildClientAssertion();
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: jwt,
    scope
  });
  const res = await fetch(EPIC_TOKEN_ENDPOINT, {
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) {
    // The token endpoint's reply stays in the server log, not the response.
    console.error('Epic token error', res.status, (await res.text()).slice(0, 200));
    const err = new Error(`Epic token error: HTTP ${res.status}`);
    // The upstream rejected this server's own credentials, not the caller.
    err.status = 502;
    throw err;
  }
  const json = await res.json();
  if (typeof json?.access_token !== 'string' || !json.access_token) {
    throw new Error('Epic token endpoint returned no access_token');
  }
  const entry = {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in || 300) * 1000,
    claims
  };
  tokenCache.set(scope, entry);
  return { accessToken: entry.accessToken, claims: entry.claims };
}

// ---- Canned Patient resources for Epic's well-known sandbox patients ----
// Plausible US Core-shaped Patient resources, used only in mock modes so
// the panel works with zero credentials. Not fetched from Epic.
const MOCK_PATIENTS = {
  'erXuFYUfucBZaryVksYEcMg3': {
    resourceType: 'Patient',
    id: 'erXuFYUfucBZaryVksYEcMg3',
    name: [{ use: 'official', family: 'Lopez', given: ['Camila', 'Maria'] }],
    gender: 'female',
    birthDate: '1987-09-12',
    identifier: [{ system: 'urn:oid:1.2.840.114350.1.13.0.1.7.5.737384.0', value: 'E4008' }]
  },
  'eq081-VQEgP8drUUqCWzHfw3': {
    resourceType: 'Patient',
    id: 'eq081-VQEgP8drUUqCWzHfw3',
    name: [{ use: 'official', family: 'Lin', given: ['Derrick'] }],
    gender: 'male',
    birthDate: '1973-06-03',
    identifier: [{ system: 'urn:oid:1.2.840.114350.1.13.0.1.7.5.737384.0', value: 'E2778' }]
  },
  'e0w0LEDCYtfckT6N.CkJKCw3': {
    resourceType: 'Patient',
    id: 'e0w0LEDCYtfckT6N.CkJKCw3',
    name: [{ use: 'official', family: 'McGinnis', given: ['Warren'] }],
    gender: 'male',
    birthDate: '1952-01-18',
    identifier: [{ system: 'urn:oid:1.2.840.114350.1.13.0.1.7.5.737384.0', value: 'E3776' }]
  },
  'eAB3mDIBBcyUKviyzrxsnAw3': {
    resourceType: 'Patient',
    id: 'eAB3mDIBBcyUKviyzrxsnAw3',
    name: [{ use: 'official', family: 'Powell', given: ['Desiree'] }],
    gender: 'female',
    birthDate: '1990-11-27',
    identifier: [{ system: 'urn:oid:1.2.840.114350.1.13.0.1.7.5.737384.0', value: 'E4530' }]
  },
  'egqBHVfQlt4Bw3XGXoxVxHg3': {
    resourceType: 'Patient',
    id: 'egqBHVfQlt4Bw3XGXoxVxHg3',
    name: [{ use: 'official', family: 'Davis', given: ['Elijah'] }],
    gender: 'male',
    birthDate: '1965-04-09',
    identifier: [{ system: 'urn:oid:1.2.840.114350.1.13.0.1.7.5.737384.0', value: 'E1234' }]
  },
  'eIXesllypH3M9tAA5WdJftQ3': {
    resourceType: 'Patient',
    id: 'eIXesllypH3M9tAA5WdJftQ3',
    name: [{ use: 'official', family: 'Ross', given: ['Linda'] }],
    gender: 'female',
    birthDate: '1958-08-21',
    identifier: [{ system: 'urn:oid:1.2.840.114350.1.13.0.1.7.5.737384.0', value: 'E5567' }]
  },
  'eh2xYHuzl9nkSFVvV3osUHg3': {
    resourceType: 'Patient',
    id: 'eh2xYHuzl9nkSFVvV3osUHg3',
    name: [{ use: 'official', family: 'Roberts', given: ['Olivia'] }],
    gender: 'female',
    birthDate: '1979-02-14',
    identifier: [{ system: 'urn:oid:1.2.840.114350.1.13.0.1.7.5.737384.0', value: 'E6689' }]
  }
};

function mockPatient(fhirId) {
  const found = Object.hasOwn(MOCK_PATIENTS, fhirId) ? MOCK_PATIENTS[fhirId] : null;
  if (found) return found;
  // Unknown id: fall back to Camila Lopez's data but keep the requested id.
  return { ...MOCK_PATIENTS['erXuFYUfucBZaryVksYEcMg3'], id: fhirId };
}

// ---- Mock Condition + Observation resources for the bundle path ----
// Only Camila Lopez carries a realistic clinical set here -- enough
// for the CQL library's HasRelevantNeuroCondition to return true and
// the bundleSummary to show non-zero counts. Other test patients get
// empty clinical resources so the flow still runs but the clinical
// prefill defines evaluate to no-match.
const MOCK_CONDITIONS = {
  'erXuFYUfucBZaryVksYEcMg3': [
    {
      resourceType: 'Condition',
      id: 'cond-lopez-migraine',
      clinicalStatus: {
        coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }]
      },
      verificationStatus: {
        coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }]
      },
      code: {
        coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'G43.909', display: 'Migraine, unspecified' }],
        text: 'Migraine, unspecified'
      },
      subject: { reference: 'Patient/erXuFYUfucBZaryVksYEcMg3' },
      recordedDate: '2025-03-10'
    },
    {
      resourceType: 'Condition',
      id: 'cond-lopez-r51',
      clinicalStatus: {
        coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }]
      },
      code: {
        coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'R51', display: 'Headache' }],
        text: 'Headache'
      },
      subject: { reference: 'Patient/erXuFYUfucBZaryVksYEcMg3' },
      recordedDate: '2026-06-01'
    }
  ]
};

const MOCK_OBSERVATIONS = {
  'erXuFYUfucBZaryVksYEcMg3': [
    {
      resourceType: 'Observation',
      id: 'obs-lopez-bp',
      status: 'final',
      category: [
        {
          coding: [
            { system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }
          ]
        }
      ],
      code: {
        coding: [{ system: 'http://loinc.org', code: '85354-9', display: 'Blood pressure panel' }]
      },
      subject: { reference: 'Patient/erXuFYUfucBZaryVksYEcMg3' },
      effectiveDateTime: '2026-07-14',
      component: [
        {
          code: { coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Systolic' }] },
          valueQuantity: { value: 128, unit: 'mmHg' }
        },
        {
          code: { coding: [{ system: 'http://loinc.org', code: '8462-4', display: 'Diastolic' }] },
          valueQuantity: { value: 82, unit: 'mmHg' }
        }
      ]
    }
  ]
};

function mockBundle(fhirId) {
  const patient = mockPatient(fhirId);
  const conditions = Object.hasOwn(MOCK_CONDITIONS, fhirId) ? MOCK_CONDITIONS[fhirId] : [];
  const observations = Object.hasOwn(MOCK_OBSERVATIONS, fhirId) ? MOCK_OBSERVATIONS[fhirId] : [];
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    entry: [
      { resource: patient },
      ...conditions.map((r) => ({ resource: r })),
      ...observations.map((r) => ({ resource: r }))
    ]
  };
}

async function epicSearch(resourceType, patientId, token) {
  const url = `${EPIC_FHIR_BASE}/${resourceType}?patient=${encodeURIComponent(patientId)}&_count=50`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/fhir+json' }
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _rawText: text };
  }
  if (!res.ok) {
    // Log-shape the failure into the returned envelope rather than
    // throwing -- Epic may deny a scope while the Patient read still
    // succeeds, and one denied resource type should not kill the whole
    // bundle fetch.
    if (res.status === 401) tokenCache.clear();
    return { ok: false, status: res.status, body: json };
  }
  return { ok: true, status: res.status, bundle: json };
}

/**
 * Fetch a FHIR searchset Bundle for the given Epic test patient:
 * Patient + Condition + Observation. Used by the DTR CQL pre-population
 * route. Falls back to a canned bundle in mock modes.
 *
 * @returns { mode, assertionClaims, bundle, warnings }
 *   warnings is an array of per-resource-type errors (e.g. denied scope)
 *   collected so the UI can render partial success honestly.
 */
export async function fetchEpicPatientBundle(fhirId) {
  if (!epicBackendEnabled()) {
    const err = new Error('Epic Backend Services integration disabled (EPIC_BACKEND_ENABLED=off)');
    err.status = 501;
    throw err;
  }

  const mode = epicBackendMode();

  if (mode !== 'live') {
    return { mode, assertionClaims: null, bundle: mockBundle(fhirId), warnings: [] };
  }

  const { accessToken: token, claims } = await getToken(epicScopes({ bundle: true }));

  // Patient is required -- fail hard if we can't read the patient
  const pRes = await fetch(`${EPIC_FHIR_BASE}/Patient/${pathSegment(fhirId, 'fhirId')}`, {
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/fhir+json' }
  });
  const pText = await pRes.text();
  let patient;
  try {
    patient = pText ? JSON.parse(pText) : null;
  } catch {
    patient = { _rawText: pText };
  }
  if (!pRes.ok) {
    const err = new Error(`Epic Patient read error: ${pRes.status}`);
    err.status = upstreamStatus(pRes.status);
    err.body = patient;
    throw err;
  }

  const warnings = [];
  const entries = [{ resource: patient }];

  for (const rt of ['Condition', 'Observation']) {
    const r = await epicSearch(rt, fhirId, token);
    if (!r.ok) {
      warnings.push({ resourceType: rt, status: r.status, body: r.body });
      continue;
    }
    for (const e of r.bundle?.entry || []) {
      if (e?.resource) entries.push({ resource: e.resource });
    }
  }

  return {
    mode: 'live',
    assertionClaims: claims,
    bundle: { resourceType: 'Bundle', type: 'searchset', entry: entries },
    warnings
  };
}

/**
 * Read a Patient from Epic's public FHIR sandbox (or a canned mock).
 *
 * Returns { mode, assertionClaims, patient }. assertionClaims is null in
 * mock modes (no assertion is built or sent) and the decoded claims object
 * in live mode, for display in the UI.
 */
export async function fetchEpicPatient(fhirId) {
  if (!epicBackendEnabled()) {
    const err = new Error('Epic Backend Services integration disabled (EPIC_BACKEND_ENABLED=off)');
    err.status = 501;
    throw err;
  }

  const mode = epicBackendMode();

  if (mode !== 'live') {
    return { mode, assertionClaims: null, patient: mockPatient(fhirId) };
  }

  const { accessToken: token, claims } = await getToken(epicScopes());
  const res = await fetch(`${EPIC_FHIR_BASE}/Patient/${pathSegment(fhirId, 'fhirId')}`, {
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/fhir+json'
    }
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _rawText: text };
  }
  if (!res.ok) {
    const err = new Error(`Epic Patient read error: ${res.status}`);
    err.status = upstreamStatus(res.status);
    err.body = json;
    throw err;
  }
  return { mode: 'live', assertionClaims: claims, patient: json };
}
