import { NextResponse } from 'next/server';

export const runtime = 'edge';

export async function GET() {
  return NextResponse.json({
    username: Boolean(process.env.USERNAME),
    password: Boolean(process.env.PASSWORD),
    storageType: process.env.NEXT_PUBLIC_STORAGE_TYPE || null,
    upstashCustom: Boolean(process.env.UPSTASH_URL && process.env.UPSTASH_TOKEN),
    upstashStandard: Boolean(
      process.env.UPSTASH_REDIS_REST_URL &&
        process.env.UPSTASH_REDIS_REST_TOKEN
    ),
  });
}
