import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { logTransaction } from '@/lib/db';

/**
 * GET /api/cql/[id]
 *
 * Serves the raw CQL source bound to a rule. Returned as a FHIR R4 `Library`
 * wrapper with the CQL text in `content[0].data` (base64). The DTR Glass Box
 * surfaces this in the Developer View pane alongside the Questionnaire JSON.
 */
export async function GET(_request, { params }) {
  const { id } = params;

  if (!/^[a-z0-9_-]+$/i.test(id)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }

  const file = path.join(process.cwd(), 'data', 'cql', `${id}.cql`);
  if (!fs.existsSync(file)) {
    logTransaction('DTR Gateway', 'CQL NOT FOUND', `CQL Library id=${id} missing on disk.`);
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const cql = fs.readFileSync(file, 'utf8');
  const library = {
    resourceType: 'Library',
    id,
    url: `http://payer.bcbsil.example/Library/${id}`,
    version: '1.0.0',
    status: 'active',
    type: {
      coding: [
        { system: 'http://terminology.hl7.org/CodeSystem/library-type', code: 'logic-library' }
      ]
    },
    content: [
      {
        contentType: 'text/cql',
        // The DTR surface prefers raw text for the developer pane; we expose
        // both: base64 in `data` (FHIR-conformant) and plain text in `_cqlText`
        // (simulator convenience). Production clients would base64-decode.
        data: Buffer.from(cql, 'utf8').toString('base64'),
        _cqlText: cql
      }
    ]
  };

  logTransaction('DTR Gateway', 'CQL SERVED', `Served Library/${id} (${cql.split('\n').length} lines).`);
  return NextResponse.json(library);
}
