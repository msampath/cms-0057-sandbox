import { NextResponse } from 'next/server';
import { getDb, saveDb, logTransaction } from '@/lib/db';

/**
 * POST /api/logs/clear
 *
 * Wipes the transactionLog without touching rules or any other section.
 * Useful for resetting the Live Traffic Feed between demo runs.
 */
export async function POST() {
  const db = getDb();
  const cleared = db.transactionLog?.length || 0;
  db.transactionLog = [];
  saveDb(db);
  // Leave a single marker line so reviewers can see "the log was reset here".
  logTransaction('Operator', 'LOG CLEAR', `Cleared ${cleared} log entries; rules untouched.`);
  return NextResponse.json({ success: true, cleared });
}
