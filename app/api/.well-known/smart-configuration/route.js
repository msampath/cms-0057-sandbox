import { NextResponse } from 'next/server';

/**
 * SMART on FHIR discovery document, served relative to this app's API base
 * per the SMART App Launch convention ([base]/.well-known/smart-configuration).
 */
export async function GET(request) {
  const origin = new URL(request.url).origin;
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
    capabilities: [
      'client-confidential-symmetric',
      'permission-v2',
      'context-standalone-patient'
    ]
  });
}
