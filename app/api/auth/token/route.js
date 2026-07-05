import { NextResponse } from 'next/server';
import { issueToken, AUTH_ENABLED } from '@/lib/auth';

/**
 * Demo SMART token endpoint.
 *
 * POST with application/x-www-form-urlencoded (or JSON) carrying
 * grant_type=client_credentials and a space-delimited scope string.
 * Returns a five-minute HS256 demo JWT. A production backend-services
 * endpoint would additionally require a signed client assertion
 * (client_assertion_type=jwt-bearer) validated against the client's
 * registered JWKS.
 */
export async function POST(request) {
  let grantType = null;
  let scope = '';
  let clientId = null;

  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => ({}));
    grantType = body.grant_type;
    scope = body.scope || '';
    clientId = body.client_id || null;
  } else {
    const form = await request.formData().catch(() => null);
    grantType = form?.get('grant_type');
    scope = form?.get('scope') || '';
    clientId = form?.get('client_id') || null;
  }

  if (grantType !== 'client_credentials') {
    return NextResponse.json(
      {
        error: 'unsupported_grant_type',
        error_description: 'This demo token endpoint supports grant_type=client_credentials only.'
      },
      { status: 400 }
    );
  }

  const token = issueToken({ scope, clientId });
  return NextResponse.json(
    { ...token, demo_auth_enforced: AUTH_ENABLED },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
