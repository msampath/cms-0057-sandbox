import { NextResponse } from 'next/server';
import { clearLog, logTransaction } from '@/lib/db';

/**
 * POST /api/logs/clear
 *
 * Resets the in-memory transaction log without touching rules.
 * Useful for resetting the Live Traffic Feed between demo runs.
 */
export async function POST() {
  const cleared = clearLog();
  logTransaction('Operator', 'LOG CLEAR', `Cleared ${cleared} log entries; rules untouched.`);
  return NextResponse.json({ success: true, cleared });
}
