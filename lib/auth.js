import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { keysAvailable, getKid, signRs384, verifyRs384 } from '@/lib/keys';

/**
 * Demo SMART on FHIR token layer.
 *
 * Issues short-lived JWTs from /api/auth/token and enforces them on the
 * three access APIs. This demonstrates the actual 401 → token → 200
 * mechanics without the production concerns: a real deployment would use
 * registered client credentials and (for backend services) a signed
 * client assertion per SMART v2. Set DEMO_AUTH=off to disable enforcement.
 *
 * Signing mode is decided per request by authMode(): when
 * SANDBOX_PRIVATE_KEY_B64 is configured (see lib/keys.js), tokens are
 * signed RS384 with that keypair and published via JWKS. Otherwise the
 * demo falls back to HMAC-SHA256 (HS256) with a process-local secret, so
 * it keeps working in any environment without the key env var set.
 *
 * The HS256 signing secret is random per process unless DEMO_JWT_SECRET
 * is set — acceptable here because tokens live for five minutes and the
 * demo runs as a single process.
 */

const SECRET =
  process.env.DEMO_JWT_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_SECONDS = 300;

export const AUTH_ENABLED = process.env.DEMO_AUTH !== 'off';

export function authMode() {
  return keysAvailable() ? 'rs384' : 'hs256';
}

function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function sign(data) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(data)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function issueToken({ scope, clientId }) {
  const now = Math.floor(Date.now() / 1000);
  const mode = authMode();
  const header = b64url(
    JSON.stringify(
      mode === 'rs384'
        ? { alg: 'RS384', typ: 'JWT', kid: getKid() }
        : { alg: 'HS256', typ: 'JWT' }
    )
  );
  const payload = b64url(
    JSON.stringify({
      iss: 'cms-0057-sandbox-auth',
      sub: clientId || 'demo-client',
      aud: 'cms-0057-sandbox-fhir',
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
      scope: scope || ''
    })
  );
  const signature =
    mode === 'rs384'
      ? signRs384(`${header}.${payload}`)
      : sign(`${header}.${payload}`);
  const token = `${header}.${payload}.${signature}`;
  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: TOKEN_TTL_SECONDS,
    scope: scope || ''
  };
}

export function verifyToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, error: 'malformed token' };
  const [header, payload, signature] = parts;

  let parsedHeader;
  try {
    parsedHeader = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return { valid: false, error: 'malformed header' };
  }

  const mode = authMode();
  const expectedAlg = mode === 'rs384' ? 'RS384' : 'HS256';
  if (parsedHeader.alg !== expectedAlg) {
    return { valid: false, error: 'algorithm mismatch' };
  }

  const signatureValid =
    mode === 'rs384'
      ? verifyRs384(`${header}.${payload}`, signature)
      : sign(`${header}.${payload}`) === signature;
  if (!signatureValid) {
    return { valid: false, error: 'invalid signature' };
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return { valid: false, error: 'unparseable payload' };
  }
  if (typeof claims.exp !== 'number' || claims.exp < Date.now() / 1000) {
    return { valid: false, error: 'token expired' };
  }
  return { valid: true, claims };
}

function securityOutcome(status, diagnostics, requiredScopes) {
  return NextResponse.json(
    {
      resourceType: 'OperationOutcome',
      issue: [
        {
          severity: 'error',
          code: status === 403 ? 'forbidden' : 'security',
          diagnostics
        }
      ]
    },
    {
      status,
      headers: {
        'WWW-Authenticate': `Bearer realm="cms-0057-sandbox", scope="${requiredScopes.join(' ')}"`
      }
    }
  );
}

/**
 * Guard for route handlers. Returns null when the request is authorized,
 * otherwise a ready-to-return 401/403 NextResponse carrying an
 * OperationOutcome and a WWW-Authenticate header.
 */
export function requireScopes(request, requiredScopes) {
  if (!AUTH_ENABLED) return null;

  const authz = request.headers.get('authorization') || '';
  const match = authz.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return securityOutcome(
      401,
      `No Bearer token presented. Obtain one from POST /api/auth/token (grant_type=client_credentials) with scope "${requiredScopes.join(' ')}".`,
      requiredScopes
    );
  }

  const { valid, claims, error } = verifyToken(match[1]);
  if (!valid) {
    return securityOutcome(401, `Token rejected: ${error}.`, requiredScopes);
  }

  const granted = (claims.scope || '').split(/\s+/).filter(Boolean);
  const missing = requiredScopes.filter((s) => !granted.includes(s));
  if (missing.length) {
    return securityOutcome(
      403,
      `Insufficient scope. Missing: ${missing.join(' ')}.`,
      requiredScopes
    );
  }

  return null;
}
