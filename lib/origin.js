/**
 * Public origin of a request. Behind Cloud Run, TLS terminates outside the
 * container, so request.url holds the internal bind address; the forwarded
 * headers carry the real host and scheme. Locally there is no forwarded
 * scheme, so the request's own scheme is used instead of assuming https.
 */
export function resolveOrigin(request) {
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  if (host) {
    const proto =
      request.headers.get('x-forwarded-proto') || new URL(request.url).protocol.replace(':', '') || 'https';
    return `${proto}://${host}`;
  }
  return new URL(request.url).origin;
}

/** The API base, e.g. https://surakshith.com/cms-0057/api */
export function apiBase(request) {
  return `${resolveOrigin(request)}/cms-0057/api`;
}
