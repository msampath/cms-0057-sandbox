import { NextResponse } from 'next/server';

/**
 * CORS for API endpoints.
 *
 * The three access APIs already gate on Bearer tokens, and the CDS Hooks
 * and FHIR discovery endpoints are meant to be publicly callable per their
 * respective specs. So the whole API surface gets permissive CORS. This is
 * what makes the sandbox reachable from browser-based test tools like the
 * CDS Hooks Sandbox at sandbox.cds-hooks.org, the SMART App Launcher at
 * launch.smarthealthit.org, and Inferno's browser-based test kits.
 *
 * `basePath: '/cms-0057'` is stripped before the matcher runs in some Next
 * 14 configurations and left in place in others, so the runtime check on
 * pathname covers both.
 */

const CORS_ORIGIN = '*';
const CORS_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';
const CORS_HEADERS = [
  'Authorization',
  'Content-Type',
  'X-Api-Mock-Scenario-ID',
  'X-Client-Id',
  'Accept',
  'Prefer'
].join(', ');

function isApiPath(pathname) {
  return pathname.startsWith('/api/') || pathname.startsWith('/cms-0057/api/');
}

export function middleware(request) {
  const { pathname } = request.nextUrl;

  if (!isApiPath(pathname)) {
    return NextResponse.next();
  }

  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': CORS_ORIGIN,
        'Access-Control-Allow-Methods': CORS_METHODS,
        'Access-Control-Allow-Headers': CORS_HEADERS,
        'Access-Control-Max-Age': '86400'
      }
    });
  }

  const response = NextResponse.next();
  response.headers.set('Access-Control-Allow-Origin', CORS_ORIGIN);
  response.headers.set(
    'Access-Control-Expose-Headers',
    'WWW-Authenticate, Content-Location, Link'
  );
  return response;
}

// Broad matcher: run everywhere except Next.js internals and static files.
// The isApiPath() check inside applies CORS only to API responses.
export const config = {
  matcher: ['/((?!_next/|favicon.ico).*)']
};
