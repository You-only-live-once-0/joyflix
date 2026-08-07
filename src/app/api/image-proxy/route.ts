import { NextResponse } from 'next/server';

export const runtime = 'edge';

const DOUBAN_IMAGE_HOSTS = [
  'img1.doubanio.com',
  'img2.doubanio.com',
  'img3.doubanio.com',
  'img9.doubanio.com',
];

function isAllowedHost(hostname: string): boolean {
  return hostname === 'doubanio.com' || hostname.endsWith('.doubanio.com');
}

function buildCandidates(imageUrl: URL): string[] {
  const candidates = [imageUrl.toString()];

  if (/^img\d+\.doubanio\.com$/.test(imageUrl.hostname)) {
    for (const hostname of DOUBAN_IMAGE_HOSTS) {
      const candidate = new URL(imageUrl.toString());
      candidate.hostname = hostname;
      candidates.push(candidate.toString());
    }
  }

  return Array.from(new Set(candidates));
}

async function fetchImage(url: string): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      cache: 'force-cache',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        Referer: 'https://movie.douban.com/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121 Safari/537.36',
      },
    });

    if (!response.ok || !response.body) return null;

    const finalUrl = new URL(response.url);
    const contentType = response.headers.get('content-type') || '';
    if (!isAllowedHost(finalUrl.hostname) || !contentType.startsWith('image/')) {
      return null;
    }

    return response;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(request: Request) {
  const imageUrlParam = new URL(request.url).searchParams.get('url');
  if (!imageUrlParam) {
    return NextResponse.json({ error: 'Missing image URL' }, { status: 400 });
  }

  let imageUrl: URL;
  try {
    imageUrl = new URL(imageUrlParam);
  } catch {
    return NextResponse.json({ error: 'Invalid image URL' }, { status: 400 });
  }

  if (
    !['http:', 'https:'].includes(imageUrl.protocol) ||
    !isAllowedHost(imageUrl.hostname)
  ) {
    return NextResponse.json({ error: 'Image host is not allowed' }, { status: 403 });
  }

  for (const candidate of buildCandidates(imageUrl)) {
    const imageResponse = await fetchImage(candidate);
    if (!imageResponse) continue;

    const headers = new Headers();
    headers.set(
      'Content-Type',
      imageResponse.headers.get('content-type') || 'image/jpeg'
    );
    headers.set(
      'Cache-Control',
      'public, max-age=604800, s-maxage=2592000, stale-while-revalidate=604800'
    );
    headers.set('Vercel-CDN-Cache-Control', 'public, s-maxage=2592000');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('X-Content-Type-Options', 'nosniff');

    return new Response(imageResponse.body, { status: 200, headers });
  }

  return NextResponse.json({ error: 'Image upstream unavailable' }, { status: 502 });
}
