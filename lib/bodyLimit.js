import { NextResponse } from 'next/server';

/**
 * Request body size guard for POST routes. Every route that reads a body
 * calls it (withUsage calls it for the routes it wraps), so no route buffers
 * an unbounded body before it knows the size.
 *
 * - A chunked body (Transfer-Encoding, no Content-Length) is refused with
 *   411, since its size is only known after it has been read.
 * - A request with neither header has no body, which is fine.
 * - A declared size over `maxBytes` is refused with 413.
 *
 * Returns a ready-to-return response, or null when the request may proceed.
 */
export function bodyTooLarge(request, maxBytes) {
  if (request.method !== 'POST') return null;
  const declared = request.headers.get('content-length');
  if (declared === null) {
    return request.headers.get('transfer-encoding')
      ? NextResponse.json({ error: 'Content-Length is required' }, { status: 411 })
      : null;
  }
  if (Number(declared) > maxBytes) {
    return NextResponse.json({ error: `Request body is larger than ${maxBytes} bytes` }, { status: 413 });
  }
  return null;
}
