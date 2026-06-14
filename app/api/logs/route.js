import { NextResponse } from 'next/server';
import { getLog } from '@/lib/db';

export async function GET() {
  return NextResponse.json({ logs: getLog() });
}
