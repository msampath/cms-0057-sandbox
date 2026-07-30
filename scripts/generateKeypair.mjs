#!/usr/bin/env node
/**
 * Generate the RS384 keypair for lib/keys.js.
 *
 * Prints to stdout only — never writes a file — so the private key
 * cannot be accidentally committed. Copy the base64 line into
 * SANDBOX_PRIVATE_KEY_B64 on Cloud Run (or a local .env for testing).
 *
 * Run once. The kid is derived deterministically from the public key
 * (RFC 7638 thumbprint), so regenerating produces a new kid — do that
 * only when actually rotating, since Epic's cached JWKS needs to catch
 * up to a new kid too.
 *
 *   node scripts/generateKeypair.mjs
 */
import crypto from 'crypto';

// With both encodings specified, generateKeyPairSync returns PEM strings
// directly rather than KeyObjects — no separate .export() call needed.
const { privateKey: pem } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const b64 = Buffer.from(pem).toString('base64');

const jwk = crypto.createPublicKey(pem).export({ format: 'jwk' });
const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
const kid = crypto.createHash('sha256').update(canonical).digest('base64url');

console.log('# RS384 keypair generated. Private key below is base64-encoded PKCS#8 PEM.');
console.log('# Set it as SANDBOX_PRIVATE_KEY_B64. Never commit this value.');
console.log('');
console.log('SANDBOX_PRIVATE_KEY_B64=' + b64);
console.log('');
console.log('# Derived kid (for reference — lib/keys.js recomputes this from the key):');
console.log('#   ' + kid);
console.log('');
console.log('# Set on Cloud Run (base64 alphabet has no commas, so no escaping needed):');
console.log(
  '#   gcloud run services update cms-0057-demo --region us-central1 \\'
);
console.log('#     --update-env-vars SANDBOX_PRIVATE_KEY_B64=' + b64);
