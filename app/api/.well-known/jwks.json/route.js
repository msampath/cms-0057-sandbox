import { NextResponse } from 'next/server';
import { keysAvailable, getPublicJwk } from '@/lib/keys';

/**
 * JWKS endpoint. Publishes the public half of the sandbox's RS384
 * keypair so relying parties can verify tokens this sandbox issues
 * (lib/auth.js) and so Epic can verify the client assertion this
 * sandbox sends as a Backend Services client (lib/epicBackend.js).
 *
 * force-dynamic because this reads process.env at request time — a
 * parameter-less GET like this one gets frozen at build time otherwise
 * and would ship a stale (likely empty) key set. See CLAUDE.md for the
 * prior instance of this exact bug class on other routes.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!keysAvailable()) {
    return NextResponse.json({ keys: [] });
  }
  return NextResponse.json({ keys: [getPublicJwk()] });
}
