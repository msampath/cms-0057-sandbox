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
const EPIC_SCOPE = 'system/Patient.read';

let cachedToken = null;

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

async function getToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5000) {
    return cachedToken.accessToken;
  }
  const { jwt } = buildClientAssertion();
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: jwt,
    scope: EPIC_SCOPE
  });
  const res = await fetch(EPIC_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Epic token error: ${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  cachedToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in || 300) * 1000
  };
  return cachedToken.accessToken;
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
  const found = MOCK_PATIENTS[fhirId];
  if (found) return found;
  // Unknown id: fall back to Camila Lopez's data but keep the requested id.
  return { ...MOCK_PATIENTS['erXuFYUfucBZaryVksYEcMg3'], id: fhirId };
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

  const { claims } = buildClientAssertion();
  const token = await getToken();
  const res = await fetch(`${EPIC_FHIR_BASE}/Patient/${fhirId}`, {
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
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return { mode: 'live', assertionClaims: claims, patient: json };
}
