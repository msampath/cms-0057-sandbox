import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { getDb, saveDb, logTransaction } from '@/lib/db';

/**
 * POST /api/rules/load-pre-ingested
 *
 * Loads the canonical pre-built rule snapshot from
 * /data/preIngestedRules.json into the active CRD memory. Used by the UM
 * Dashboard's "Use previously ingested rules" button so demos can skip
 * the upload flow when they want a populated index out of the gate.
 *
 * Idempotent: replaces whatever is in active memory with the snapshot.
 */
export async function POST() {
  const file = path.join(process.cwd(), 'data', 'preIngestedRules.json');
  if (!fs.existsSync(file)) {
    return NextResponse.json(
      { error: 'pre-ingested rules file missing' },
      { status: 500 }
    );
  }
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  const db = getDb();
  db.rules = snapshot.rules;
  saveDb(db);

  logTransaction(
    'Ingestion Engine',
    'STATE COMMIT',
    `Loaded ${snapshot.rules.length} pre-ingested rules (snapshot @ ${snapshot.generatedAt}). Sources: ${snapshot.perFile.map((p) => `${p.name} (${p.added})`).join(', ')}.`
  );

  return NextResponse.json({
    success: true,
    count: snapshot.rules.length,
    perFile: snapshot.perFile,
    generatedAt: snapshot.generatedAt
  });
}
