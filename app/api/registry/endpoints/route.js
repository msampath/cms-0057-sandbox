import { NextResponse } from 'next/server';
import { PAYER_NAME } from '@/lib/patients';

export const dynamic = 'force-dynamic';

/**
 * GET /api/registry/endpoints
 *
 * Endpoint report for a CMS-published directory (CMS-0062-P, preamble
 * II.E). The rule's primary proposal is a base FHIR Endpoint resource per
 * API. The NDH Endpoint profile is the alternative CMS asked about, so these
 * resources do not claim it. CMS also asked whether a machine-readable file
 * on its website would be enough (II.E.5).
 *
 * Addresses use the forwarded origin, like the SMART discovery document,
 * because Cloud Run terminates TLS in front of the container.
 */
function resolveOrigin(request) {
  const forwardedHost = request.headers.get('x-forwarded-host') || request.headers.get('host');
  if (forwardedHost) {
    // Behind Cloud Run the proto header is set. Locally it is not, so the
    // request's own scheme (http) is used instead of assuming https.
    const forwardedProto =
      request.headers.get('x-forwarded-proto') || new URL(request.url).protocol.replace(':', '') || 'https';
    return `${forwardedProto}://${forwardedHost}`;
  }
  return new URL(request.url).origin;
}

const APIS = [
  {
    id: 'prior-authorization',
    name: 'Prior Authorization API (Da Vinci CRD, DTR, PAS)',
    path: '/pas/submit',
    payload: 'Da Vinci PAS Claim/$submit (CRD discovery at /cds-services)',
    cfr: '45 CFR 156.223, 42 CFR 422.122, 431.80, 457.732'
  },
  {
    id: 'patient-access',
    name: 'Patient Access API',
    path: '/patient-access',
    payload: 'US Core, CARIN BB, PDex (patient/*.read scopes)',
    cfr: '45 CFR 156.221(a), 42 CFR 422.119(a), 431.60(a), 457.730(a)'
  },
  {
    id: 'provider-access',
    name: 'Provider Access API',
    path: '/provider-access',
    payload: 'PDex (system/*.read scopes)',
    cfr: '45 CFR 156.222(a), 42 CFR 422.121(a), 431.61(a), 457.731(a)'
  },
  {
    id: 'payer-to-payer',
    name: 'Payer-to-Payer API',
    path: '/payer-to-payer/member-match',
    payload: 'HRex $member-match, PDex history (system/*.read scopes)',
    cfr: '45 CFR 156.222(b), 42 CFR 422.121(b), 431.61(b), 457.731(b)'
  }
];

export async function GET(request) {
  const base = `${resolveOrigin(request)}/cms-0057/api`;
  const endpoints = APIS.map((a) => ({
    resourceType: 'Endpoint',
    id: a.id,
    status: 'active',
    connectionType: {
      system: 'http://terminology.hl7.org/CodeSystem/endpoint-connection-type',
      code: 'hl7-fhir-rest'
    },
    name: a.name,
    managingOrganization: { display: PAYER_NAME },
    payloadType: [{ text: a.payload }],
    payloadMimeType: ['application/fhir+json'],
    address: `${base}${a.path}`,
    header: [`X-Regulation: ${a.cfr}`]
  }));

  return NextResponse.json({
    resourceType: 'Bundle',
    id: 'payer-endpoint-report',
    type: 'collection',
    timestamp: new Date().toISOString(),
    // fullUrl matches each resource's id and carries no fragment.
    entry: endpoints.map((resource) => ({
      fullUrl: `${base}/registry/endpoints/Endpoint/${resource.id}`,
      resource
    }))
  });
}
