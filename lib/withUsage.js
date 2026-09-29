import { NextResponse } from 'next/server';
import { recordApiUsage } from './db';

/**
 * Wraps a route handler to record one API usage event per call, for the
 * CMS-0062-P usage metrics (position 4: success and error rates, not only
 * call volume).
 *
 * Buckets:
 *   success          2xx and 3xx
 *   unauthenticated  401 with no Authorization header. The 401 → token → 200
 *                    sequence is a scripted demo step, so it is counted apart
 *                    and does not raise the error rate
 *   authFailure      401 with a token (bad or expired), or 403 (scopes)
 *   clientError      any other 4xx
 *   serverError      5xx, or a handler that throws
 */
const badBody = (diagnostics) =>
  NextResponse.json(
    { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'structure', diagnostics }] },
    { status: 400 }
  );

const MAX_BODY_BYTES = 1024 * 1024;

class BadBodyError extends Error {}

// Every wrapped POST route takes a JSON object. The body is parsed once
// here, and request.json() is replaced so the handler gets that object, or
// a BadBodyError when the body is not JSON or is null, an array, or a
// primitive. The handler reads the body after its auth check, so an
// unauthenticated caller still gets 401 first.
async function prepareJsonBody(request) {
  if (request.method !== 'POST') return null;
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY_BYTES) {
    return NextResponse.json(
      { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'too-long', diagnostics: 'Request body is larger than 1 MB.' }] },
      { status: 413 }
    );
  }
  const text = await request.text();
  // A chunked body has no content-length, so the size read is checked too.
  if (text.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'too-long', diagnostics: 'Request body is larger than 1 MB.' }] },
      { status: 413 }
    );
  }
  let parsed, error = null;
  try {
    parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) error = 'Request body must be a JSON object.';
  } catch {
    error = 'Request body is not valid JSON.';
  }
  Object.defineProperty(request, 'json', {
    configurable: true,
    value: async () => {
      if (error) throw new BadBodyError(error);
      return parsed;
    }
  });
  Object.defineProperty(request, 'text', { configurable: true, value: async () => text });
  return null;
}

export function withUsage(api, handler) {
  return async function metered(request, context) {
    const tooLarge = await prepareJsonBody(request);
    if (tooLarge) {
      recordApiUsage(api, 'clientError');
      return tooLarge;
    }
    let response;
    try {
      response = await handler(request, context);
    } catch (err) {
      if (err instanceof BadBodyError) {
        recordApiUsage(api, 'clientError');
        return badBody(err.message);
      }
      recordApiUsage(api, 'serverError');
      throw err;
    }
    const status = response?.status ?? 200;
    // Any credential counts as an attempt (Bearer or not), so a rejected one
    // is an auth failure rather than the no-token demo step.
    const hasToken = (request.headers.get('authorization') || '').trim().length > 0;
    const bucket =
      status >= 500 ? 'serverError'
        : status === 401 ? (hasToken ? 'authFailure' : 'unauthenticated')
          : status === 403 ? 'authFailure'
            : status >= 400 ? 'clientError'
              : 'success';
    recordApiUsage(api, bucket);
    return response;
  };
}
