import { NextResponse } from 'next/server';

/**
 * SMART on FHIR discovery document, served relative to this app's API base
 * per the SMART App Launch convention ([base]/.well-known/smart-configuration).
 *
 * Origin must come from the forwarded headers, not request.url. Cloud Run
 * terminates TLS externally and proxies internally, so request.url inside
 * the container reflects the internal bind address (localhost) rather
 * than the public host — Cloud Run does set x-forwarded-host/-proto,
 * which is the standard way to recover the real origin behind a proxy.
 */
function resolveOrigin(request) {
  const forwardedHost = request.headers.get('x-forwarded-host') || request.headers.get('host');
  if (forwardedHost) {
    const forwardedProto = request.headers.get('x-forwarded-proto') || 'https';
    return `${forwardedProto}://${forwardedHost}`;
  }
  return new URL(request.url).origin;
}

export async function GET(request) {
  const origin = resolveOrigin(request);
  const base = `${origin}/cms-0057/api`;
  return NextResponse.json({
    issuer: 'cms-0057-sandbox-auth',
    token_endpoint: `${base}/auth/token`,
    grant_types_supported: ['client_credentials'],
    scopes_supported: [
      'patient/Patient.read',
      'patient/Coverage.read',
      'patient/ExplanationOfBenefit.read',
      'patient/ClaimResponse.read',
      'system/Patient.read',
      'system/Coverage.read',
      'system/ExplanationOfBenefit.read',
      'system/ClaimResponse.read'
    ],
    response_types_supported: ['token'],
    jwks_uri: `${base}/.well-known/jwks.json`,
    token_endpoint_auth_methods_supported: ['private_key_jwt'],
    token_endpoint_auth_signing_alg_values_supported: ['RS384'],
    capabilities: [
      'client-confidential-symmetric',
      'permission-v2',
      'context-standalone-patient',
      'client-confidential-asymmetric'
    ]
  });
}
