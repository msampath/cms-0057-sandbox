/**
 * SMART on FHIR EHR launch client helpers.
 *
 * Implements the EHR-launched public-client PKCE flow so the sandbox's
 * /ehr surface can be launched from an external SMART App Launcher (like
 * launch.smarthealthit.org or Epic's fhir.epic.com sandbox) rather than
 * only from the hardcoded patient picker.
 *
 * Flow:
 *   EHR redirects browser -> /ehr/launch?iss=<fhirBase>&launch=<ctx>
 *     -> discover({iss}/.well-known/smart-configuration)
 *     -> generate PKCE + state, stash in sessionStorage
 *     -> redirect to <authorize>?...
 *   User approves at the EHR
 *   EHR redirects browser -> /ehr/callback?code=<c>&state=<s>
 *     -> exchange code + code_verifier at <token> for access_token
 *     -> store token + patient context in sessionStorage
 *     -> redirect to /ehr
 *   /ehr detects sessionStorage on mount, shows launched-context banner,
 *   uses the launched patient in place of the picker.
 *
 * Public client, no secret. Not real SMART auth for the sandbox's own
 * data (which uses the demo JWT flow in lib/auth.js) — this is strictly
 * for talking to an external EHR that has launched us.
 */

const SS_KEY_PENDING = 'smart:pending';
const SS_KEY_SESSION = 'smart:session';

const REQUESTED_SCOPES = [
  'launch',
  'openid',
  'fhirUser',
  'patient/Patient.read',
  'patient/Coverage.read'
].join(' ');

function b64urlEncode(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sha256(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return b64urlEncode(digest);
}

function randomString(len = 64) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return b64urlEncode(bytes);
}

export async function fetchSmartConfiguration(iss) {
  const base = iss.replace(/\/+$/, '');
  const res = await fetch(`${base}/.well-known/smart-configuration`, {
    headers: { Accept: 'application/json' }
  });
  if (!res.ok) {
    throw new Error(`SMART discovery failed at ${base}: ${res.status}`);
  }
  return res.json();
}

/**
 * Handle the EHR launch redirect. Called from /ehr/launch.
 *
 * Discovers SMART config, generates PKCE + state, stashes them, and
 * returns the authorize URL to redirect to.
 */
export async function beginLaunch({ iss, launch, redirectUri, clientId }) {
  if (!iss || !launch) {
    throw new Error('Missing iss or launch parameter');
  }
  const config = await fetchSmartConfiguration(iss);
  if (!config.authorization_endpoint || !config.token_endpoint) {
    throw new Error('SMART config missing authorization or token endpoint');
  }

  const codeVerifier = randomString(64);
  const codeChallenge = await sha256(codeVerifier);
  const state = randomString(24);

  sessionStorage.setItem(
    SS_KEY_PENDING,
    JSON.stringify({
      iss,
      launch,
      state,
      codeVerifier,
      tokenEndpoint: config.token_endpoint,
      clientId
    })
  );

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    launch,
    scope: REQUESTED_SCOPES,
    state,
    aud: iss,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });
  return `${config.authorization_endpoint}?${params.toString()}`;
}

/**
 * Handle the OAuth callback. Called from /ehr/callback.
 *
 * Exchanges the code for a token, stores the launched session, and
 * returns the parsed context.
 */
export async function completeLaunch({ code, state, redirectUri }) {
  const raw = sessionStorage.getItem(SS_KEY_PENDING);
  if (!raw) throw new Error('No pending launch in this session');
  const pending = JSON.parse(raw);
  if (state !== pending.state) throw new Error('State mismatch');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.codeVerifier
  });

  const res = await fetch(pending.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const tokens = await res.json();

  const session = {
    iss: pending.iss,
    accessToken: tokens.access_token,
    tokenType: tokens.token_type || 'Bearer',
    expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
    patientId: tokens.patient || null,
    encounterId: tokens.encounter || null,
    scope: tokens.scope || '',
    idToken: tokens.id_token || null
  };
  sessionStorage.setItem(SS_KEY_SESSION, JSON.stringify(session));
  sessionStorage.removeItem(SS_KEY_PENDING);
  return session;
}

export function getLaunchedSession() {
  if (typeof window === 'undefined') return null;
  const raw = sessionStorage.getItem(SS_KEY_SESSION);
  if (!raw) return null;
  const session = JSON.parse(raw);
  if (session.expiresAt && Date.now() > session.expiresAt) {
    sessionStorage.removeItem(SS_KEY_SESSION);
    return null;
  }
  return session;
}

export function clearLaunchedSession() {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(SS_KEY_SESSION);
  sessionStorage.removeItem(SS_KEY_PENDING);
}

/**
 * Fetch the launched patient from the external EHR using the access token.
 */
export async function fetchLaunchedPatient(session) {
  if (!session || !session.patientId) return null;
  const base = session.iss.replace(/\/+$/, '');
  const res = await fetch(`${base}/Patient/${session.patientId}`, {
    headers: {
      Authorization: `${session.tokenType} ${session.accessToken}`,
      Accept: 'application/fhir+json'
    }
  });
  if (!res.ok) return null;
  return res.json();
}
