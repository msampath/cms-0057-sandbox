import { NextResponse } from 'next/server';

/**
 * Fixed-window rate limit for the outbound integration routes (Optum,
 * Availity, Epic). In live mode each call spends the owner's sandbox quota,
 * and these routes need no token, so a global cap per integration keeps an
 * anonymous caller from draining it. One Cloud Run instance, so an
 * in-memory counter is enough.
 */
const WINDOW_MS = 60_000;
const windows = new Map(); // name -> { start, count }

export function outboundRateLimit(name, max = 60) {
  const now = Date.now();
  const w = windows.get(name);
  if (!w || now - w.start >= WINDOW_MS) {
    windows.set(name, { start: now, count: 1 });
    return null;
  }
  w.count += 1;
  if (w.count <= max) return null;
  const retryAfter = Math.ceil((w.start + WINDOW_MS - now) / 1000);
  return NextResponse.json(
    { error: `Too many ${name} calls. Try again in ${retryAfter} seconds.` },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } }
  );
}
