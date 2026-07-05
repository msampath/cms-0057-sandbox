import crypto from 'crypto';
import { NextResponse } from 'next/server';

/**
 * Demo SMART on FHIR token layer.
 *
 * Issues short-lived HMAC-SHA256 (HS256) JWTs from /api/auth/token and
 * enforces them on the three access APIs. This demonstrates the actual
 * 401 → token → 200 mechanics without the production concerns: a real
 * deployment would use asymmetric keys published via JWKS, registered
 * client credentials, and (for backend services) a signed client
 * assertion per SMART v2. Set DEMO_AUTH=off to disable enforcement.
 *
 * The signing secret is random per process unless DEMO_JWT_SECRET is set —
 * acceptable here because tokens live for five minutes and the demo runs
 * as a single process.
 */

const SECRET =
  process.env.DEMO_JWT_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_SECONDS = 300;

export const AUTH_ENABLED = process.env.DEMO_AUTH !== 'off';

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
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: 'cms-0057-demo-auth',
      sub: clientId || 'demo-client',
      aud: 'cms-0057-demo-fhir',
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
      scope: scope || ''
    })
  );
  const token = `${header}.${payload}.${sign(`${header}.${payload}`)}`;
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
  if (sign(`${header}.${payload}`) !== signature) {
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
        'WWW-Authenticate': `Bearer realm="cms-0057-demo", scope="${requiredScopes.join(' ')}"`
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
