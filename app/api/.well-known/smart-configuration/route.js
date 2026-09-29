import { NextResponse } from 'next/server';
import { apiBase } from '@/lib/origin';

/**
 * SMART on FHIR discovery document, served relative to this app's API base
 * per the SMART App Launch convention ([base]/.well-known/smart-configuration).
 *
 * Origin comes from the forwarded headers via lib/origin.js, not
 * request.url, because Cloud Run terminates TLS outside the container.
 *
 * Only what the demo token endpoint does is advertised: client_credentials
 * with v1-style scopes and no client authentication. The JWKS still
 * publishes the RS384 key when one is configured.
 */
export async function GET(request) {
  const base = apiBase(request);
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
    token_endpoint_auth_methods_supported: ['none'],
    capabilities: ['permission-v1']
  });
}
