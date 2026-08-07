import { NextResponse } from 'next/server';

export const runtime = 'edge';

export async function GET() {
  const matchingKeys = Object.keys(process.env)
    .filter((key) => /(UPSTASH|REDIS|KV_)/i.test(key))
    .sort();

  return NextResponse.json({ matchingKeys });
}
