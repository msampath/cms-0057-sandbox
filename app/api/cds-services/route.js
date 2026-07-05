import { NextResponse } from 'next/server';

/**
 * CDS Hooks 2.0 discovery endpoint.
 *
 * The spec requires GET {baseUrl}/cds-services returning the service
 * catalog, with each service invoked at {baseUrl}/cds-services/{id}. With
 * this app's base of /cms-0057/api, discovery is /cms-0057/api/cds-services
 * and the order-sign service already lives at
 * /cms-0057/api/cds-services/order-sign, so the URL structure matches the
 * spec convention without any remapping.
 *
 * The response is constant, so build-time static optimization is fine here.
 */
export async function GET() {
  return NextResponse.json({
    services: [
      {
        hook: 'order-sign',
        title: 'BCBSIL prior authorization requirements (Da Vinci CRD)',
        description:
          'Evaluates signed orders against the BCBSIL 2026 prior authorization grids. Returns a coverage-requirements card (info / warning / critical / hard-stop), a DTR SMART app launch link when documentation is required, and a Da Vinci CRD coverage-information system action.',
        id: 'order-sign',
        prefetch: {
          patient: 'Patient/{{context.patientId}}',
          coverage: 'Coverage?patient={{context.patientId}}'
        }
      }
    ]
  });
}
