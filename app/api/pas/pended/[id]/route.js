import { NextResponse } from 'next/server';
import { getPendingRequest } from '@/lib/db';

export async function GET(request, { params }) {
  const req = getPendingRequest(params.id);
  if (!req) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(req);
}
