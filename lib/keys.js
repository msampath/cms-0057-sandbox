import crypto from 'crypto';

/**
 * RS384 signing key for the sandbox.
 *
 * One keypair, two consumers: lib/auth.js signs this sandbox's own SMART
 * demo tokens with it, and lib/epicBackend.js signs the client assertion
 * sent to Epic's Backend Services token endpoint with it. Both need the
 * same published JWKS so a verifier only has to fetch one URL.
 *
 * Private key comes from SANDBOX_PRIVATE_KEY_B64 — a base64-encoded
 * PKCS#8 PEM, base64 because multi-line PEMs do not survive Cloud Run
 * env vars cleanly. Read at call time (not module load) so the demo can
 * flip between HS256 and RS384 without a restart in local dev, and so a
 * frozen empty state is never cached before the env var is actually set.
 *
 * When SANDBOX_PRIVATE_KEY_B64 is unset, keysAvailable() is false and
 * every other export throws if called — callers must check
 * keysAvailable() first. This is deliberate: the demo runs fine on the
 * HS256 fallback in lib/auth.js when no key is configured, and the JWKS
 * route returns an empty key set rather than erroring.
 */

let cached = null; // { privateKey, publicJwk, kid }

export function keysAvailable() {
  return Boolean(process.env.SANDBOX_PRIVATE_KEY_B64);
}

// RFC 7638 JWK thumbprint: SHA-256 over canonical JSON with member names
// in lexicographic order, no whitespace. For RSA that's exactly {e,kty,n}.
function rfc7638Thumbprint(jwk) {
  const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  return crypto.createHash('sha256').update(canonical).digest('base64url');
}

function load() {
  if (cached) return cached;
  if (!keysAvailable()) {
    throw new Error('SANDBOX_PRIVATE_KEY_B64 is not set');
  }
  const pem = Buffer.from(process.env.SANDBOX_PRIVATE_KEY_B64, 'base64').toString('utf8');
  const privateKey = crypto.createPrivateKey(pem);
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' }); // { kty:'RSA', n, e }
  const kid = rfc7638Thumbprint(jwk);
  cached = {
    privateKey,
    publicJwk: { ...jwk, alg: 'RS384', use: 'sig', kid },
    kid
  };
  return cached;
}

export function getPublicJwk() {
  return load().publicJwk;
}

export function getKid() {
  return load().kid;
}

// RS384 = RSASSA-PKCS1-v1_5 with SHA-384. Node's default RSA padding for
// crypto.sign/verify is PKCS#1 v1.5, so no explicit padding option is
// needed — passing one would require importing constants for no benefit.
export function signRs384(data) {
  return crypto.sign('sha384', Buffer.from(data), load().privateKey).toString('base64url');
}

export function verifyRs384(data, signatureB64url) {
  const pub = crypto.createPublicKey(load().privateKey);
  return crypto.verify(
    'sha384',
    Buffer.from(data),
    pub,
    Buffer.from(signatureB64url, 'base64url')
  );
}
