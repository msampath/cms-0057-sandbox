import { apiUrl } from './basePath';

/**
 * Client-side helper for the demo SMART token flow.
 *
 * Fetches client_credentials tokens from /api/auth/token, caches them per
 * scope set, and refreshes when fewer than thirty seconds remain. The
 * surfaces use authedFetch() so every access-API call carries a Bearer
 * header, mirroring what a production SMART client would do.
 */

const cache = new Map(); // scope string -> { token, expiresAt (epoch s) }

export async function getDemoToken(scopes) {
  const key = scopes.join(' ');
  const hit = cache.get(key);
  if (hit && hit.expiresAt - 30 > Date.now() / 1000) return hit.token;

  const res = await fetch(apiUrl('/api/auth/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'demo-ui',
      scope: key
    })
  });
  if (!res.ok) throw new Error(`token endpoint returned HTTP ${res.status}`);
  const token = await res.json();
  cache.set(key, {
    token,
    expiresAt: Math.floor(Date.now() / 1000) + (token.expires_in || 300)
  });
  return token;
}

export async function authedFetch(url, scopes, init = {}) {
  const token = await getDemoToken(scopes);
  return fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token.access_token}`
    }
  });
}

export function decodeJwtPayload(token) {
  try {
    const [, payload] = token.split('.');
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}
