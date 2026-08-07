import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function write(path, content) {
  fs.writeFileSync(path, content);
}

function replaceOnce(content, search, replacement, label) {
  if (!content.includes(search)) {
    throw new Error(`Patch target not found: ${label}`);
  }
  return content.replace(search, replacement);
}

// 1. Deduplicate favorites requests across all cards.
{
  const path = 'src/lib/db.client.ts';
  let content = read(path);
  const anchor = 'const cacheManager = HybridCacheManager.getInstance();\n';
  const helper = `\nlet favoritesFetchPromise: Promise<Record<string, Favorite>> | null = null;\nlet lastFavoritesFetchAt = 0;\nconst FAVORITES_SYNC_INTERVAL = 60_000;\n\nfunction fetchFavoritesShared(): Promise<Record<string, Favorite>> {\n  if (!favoritesFetchPromise) {\n    lastFavoritesFetchAt = Date.now();\n    favoritesFetchPromise = fetchFromApi<Record<string, Favorite>>(\n      '/api/favorites'\n    )\n      .then((freshData) => {\n        cacheManager.cacheFavorites(freshData);\n        return freshData;\n      })\n      .finally(() => {\n        favoritesFetchPromise = null;\n      });\n  }\n\n  return favoritesFetchPromise;\n}\n\nfunction syncFavoritesInBackground(\n  cachedFavorites: Record<string, Favorite>\n): void {\n  if (Date.now() - lastFavoritesFetchAt < FAVORITES_SYNC_INTERVAL) return;\n\n  void fetchFavoritesShared()\n    .then((freshData) => {\n      if (JSON.stringify(cachedFavorites) !== JSON.stringify(freshData)) {\n        window.dispatchEvent(\n          new CustomEvent('favoritesUpdated', { detail: freshData })\n        );\n      }\n    })\n    .catch((err) => {\n      console.warn('后台同步收藏失败:', err);\n    });\n}\n`;

  if (!content.includes('const FAVORITES_SYNC_INTERVAL = 60_000;')) {
    content = replaceOnce(content, anchor, anchor + helper, 'favorites helper');
  }

  const functionStart = content.indexOf('export async function isFavorited(');
  const functionEndMarker = '\n}\n\n/**\n * 清空全部播放记录';
  const functionEnd = content.indexOf(functionEndMarker, functionStart);
  if (functionStart < 0 || functionEnd < 0) {
    throw new Error('isFavorited function not found');
  }

  let section = content.slice(functionStart, functionEnd + 2);
  const cachedStart = section.indexOf('    if (cachedFavorites) {');
  const elseIndex = section.indexOf('    } else {', cachedStart);
  if (cachedStart < 0 || elseIndex < 0) {
    throw new Error('isFavorited cached branch not found');
  }

  section =
    section.slice(0, cachedStart) +
    `    if (cachedFavorites) {\n      syncFavoritesInBackground(cachedFavorites);\n      return !!cachedFavorites[key];\n` +
    section.slice(elseIndex);

  const oldEmptyFetch = `        const freshData = await fetchFromApi<Record<string, Favorite>>(\n          \`/api/favorites\`\n        );\n        cacheManager.cacheFavorites(freshData);`;
  section = replaceOnce(
    section,
    oldEmptyFetch,
    '        const freshData = await fetchFavoritesShared();',
    'isFavorited single-flight fetch'
  );

  content = content.slice(0, functionStart) + section + content.slice(functionEnd + 2);
  write(path, content);
}

// 2. Route Douban images through the local cached proxy.
{
  const path = 'src/app/layout.tsx';
  let content = read(path);
  content = replaceOnce(
    content,
    "process.env.NEXT_PUBLIC_DOUBAN_IMAGE_PROXY_TYPE || 'img3';",
    "process.env.NEXT_PUBLIC_DOUBAN_IMAGE_PROXY_TYPE || 'server';",
    'layout image proxy default'
  );
  write(path, content);
}

{
  const path = 'src/lib/utils.ts';
  let content = read(path);
  const oldConfig = `  const doubanImageProxyType =\n    localStorage.getItem('doubanImageProxyType') ||\n    (window as any).RUNTIME_CONFIG?.DOUBAN_IMAGE_PROXY_TYPE ||\n    'direct';\n  const doubanImageProxy =\n    localStorage.getItem('doubanImageProxyUrl') ||\n    (window as any).RUNTIME_CONFIG?.DOUBAN_IMAGE_PROXY ||\n    '';`;
  const newConfig = `  const runtimeConfig = (window as any).RUNTIME_CONFIG;\n  const doubanImageProxyType =\n    runtimeConfig?.DOUBAN_IMAGE_PROXY_TYPE ||\n    localStorage.getItem('doubanImageProxyType') ||\n    'server';\n  const doubanImageProxy =\n    runtimeConfig?.DOUBAN_IMAGE_PROXY ||\n    localStorage.getItem('doubanImageProxyUrl') ||\n    '';`;
  content = replaceOnce(content, oldConfig, newConfig, 'image proxy preference');
  write(path, content);
}

// 3. Allow the image optimizer to access the proxy without a user cookie.
{
  const path = 'src/middleware.ts';
  let content = read(path);
  content = replaceOnce(
    content,
    'api/logout|api/cron|api/server-config|api/recommendations',
    'api/logout|api/cron|api/image-proxy|api/server-config|api/recommendations',
    'middleware image proxy exclusion'
  );
  write(path, content);
}

// 4. Harden the proxy and add resilient host fallback plus long CDN caching.
{
  const path = 'src/app/api/image-proxy/route.ts';
  const content = `import { NextResponse } from 'next/server';\n\nexport const runtime = 'edge';\n\nconst DOUBAN_IMAGE_HOSTS = [\n  'img1.doubanio.com',\n  'img2.doubanio.com',\n  'img3.doubanio.com',\n  'img9.doubanio.com',\n];\n\nfunction isAllowedHost(hostname: string): boolean {\n  return hostname === 'doubanio.com' || hostname.endsWith('.doubanio.com');\n}\n\nfunction buildCandidates(imageUrl: URL): string[] {\n  const candidates = [imageUrl.toString()];\n\n  if (/^img\\d+\\.doubanio\\.com$/.test(imageUrl.hostname)) {\n    for (const hostname of DOUBAN_IMAGE_HOSTS) {\n      const candidate = new URL(imageUrl.toString());\n      candidate.hostname = hostname;\n      candidates.push(candidate.toString());\n    }\n  }\n\n  return Array.from(new Set(candidates));\n}\n\nasync function fetchImage(url: string): Promise<Response | null> {\n  const controller = new AbortController();\n  const timeout = setTimeout(() => controller.abort(), 5000);\n\n  try {\n    const response = await fetch(url, {\n      cache: 'force-cache',\n      redirect: 'follow',\n      signal: controller.signal,\n      headers: {\n        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',\n        Referer: 'https://movie.douban.com/',\n        'User-Agent':\n          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121 Safari/537.36',\n      },\n    });\n\n    if (!response.ok || !response.body) return null;\n\n    const finalUrl = new URL(response.url);\n    const contentType = response.headers.get('content-type') || '';\n    if (!isAllowedHost(finalUrl.hostname) || !contentType.startsWith('image/')) {\n      return null;\n    }\n\n    return response;\n  } catch {\n    return null;\n  } finally {\n    clearTimeout(timeout);\n  }\n}\n\nexport async function GET(request: Request) {\n  const imageUrlParam = new URL(request.url).searchParams.get('url');\n  if (!imageUrlParam) {\n    return NextResponse.json({ error: 'Missing image URL' }, { status: 400 });\n  }\n\n  let imageUrl: URL;\n  try {\n    imageUrl = new URL(imageUrlParam);\n  } catch {\n    return NextResponse.json({ error: 'Invalid image URL' }, { status: 400 });\n  }\n\n  if (\n    !['http:', 'https:'].includes(imageUrl.protocol) ||\n    !isAllowedHost(imageUrl.hostname)\n  ) {\n    return NextResponse.json({ error: 'Image host is not allowed' }, { status: 403 });\n  }\n\n  for (const candidate of buildCandidates(imageUrl)) {\n    const imageResponse = await fetchImage(candidate);\n    if (!imageResponse) continue;\n\n    const headers = new Headers();\n    headers.set(\n      'Content-Type',\n      imageResponse.headers.get('content-type') || 'image/jpeg'\n    );\n    headers.set(\n      'Cache-Control',\n      'public, max-age=604800, s-maxage=2592000, stale-while-revalidate=604800'\n    );\n    headers.set('Vercel-CDN-Cache-Control', 'public, s-maxage=2592000');\n    headers.set('Access-Control-Allow-Origin', '*');\n    headers.set('X-Content-Type-Options', 'nosniff');\n\n    return new Response(imageResponse.body, { status: 200, headers });\n  }\n\n  return NextResponse.json({ error: 'Image upstream unavailable' }, { status: 502 });\n}\n`;
  write(path, content);
}

// 5. Enable Vercel image optimization and request card-sized assets.
{
  const path = 'next.config.js';
  let content = read(path);
  content = replaceOnce(
    content,
    `  images: {\n    unoptimized: true,\n    remotePatterns: [`,
    `  images: {\n    formats: ['image/avif', 'image/webp'],\n    minimumCacheTTL: 2592000,\n    remotePatterns: [`,
    'Next image optimization'
  );
  write(path, content);
}

{
  const path = 'src/components/VideoCard.tsx';
  let content = read(path);
  content = replaceOnce(
    content,
    `          fill\n          className='object-cover'`,
    `          fill\n          sizes='(max-width: 640px) 33vw, (max-width: 1024px) 20vw, 180px'\n          quality={65}\n          className='object-cover'`,
    'VideoCard responsive image sizing'
  );
  write(path, content);
}

// Remove the one-shot patch files before the final commit.
fs.rmSync('scripts/apply-performance-patch.mjs', { force: true });
fs.rmSync('.github/workflows/apply-performance-patch.yml', { force: true });
