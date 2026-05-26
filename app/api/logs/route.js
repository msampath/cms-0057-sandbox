import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET() {
  return NextResponse.json({ logs: getDb().transactionLog });
}
