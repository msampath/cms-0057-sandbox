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
export function withUsage(api, handler) {
  return async function metered(request, context) {
    let response;
    try {
      response = await handler(request, context);
    } catch (err) {
      // A malformed request body (request.json() throws SyntaxError) is the
      // caller's error: answer 400 instead of letting Next return a 500.
      if (err instanceof SyntaxError) {
        recordApiUsage(api, 'clientError');
        return NextResponse.json(
          { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'structure', diagnostics: 'Request body is not valid JSON.' }] },
          { status: 400 }
        );
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
