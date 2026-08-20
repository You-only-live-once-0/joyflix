import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TOKEN = 'c7VJQ4n8Kf3sP6wZ2mT9';
const ROOT = '/tmp/libredwg-web-0.7.9';
const TGZ = 'https://registry.npmjs.org/@mlightcad/libredwg-web/-/libredwg-web-0.7.9.tgz';

function parseOctal(buf: Buffer, start: number, length: number): number {
  const s = buf.subarray(start, start + length).toString('utf8').replace(/\0/g, '').trim();
  return s ? parseInt(s, 8) : 0;
}

async function ensurePackage() {
  if (existsSync(join(ROOT, 'dist', 'libredwg-web.js'))) return;
  const response = await fetch(TGZ, { cache: 'no-store' });
  if (!response.ok) throw new Error(`npm download failed: ${response.status}`);
  const tar = gunzipSync(Buffer.from(await response.arrayBuffer()));
  await mkdir(ROOT, { recursive: true });
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const name = rawName.startsWith('package/') ? rawName.slice(8) : rawName;
    const target = join(ROOT, name);
    if (name && type !== '5') {
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, tar.subarray(off + 512, off + 512 + size));
    } else if (name) {
      await mkdir(target, { recursive: true });
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    if (url.searchParams.get('k') !== TOKEN) return new Response('Forbidden', { status: 403 });
    const src = url.searchParams.get('src');
    if (!src || !/^https:\/\//i.test(src)) return new Response('Missing src', { status: 400 });

    await ensurePackage();
    const mod: any = await import(pathToFileURL(join(ROOT, 'dist', 'libredwg-web.js')).href);
    const libredwg = await mod.LibreDwg.create(join(ROOT, 'wasm') + '/');

    const sourceResponse = await fetch(src, { cache: 'no-store' });
    if (!sourceResponse.ok) throw new Error(`source download failed: ${sourceResponse.status}`);
    const content = await sourceResponse.arrayBuffer();
    const dwg = libredwg.dwg_read_data(content, mod.Dwg_File_Type.DWG);
    const db = libredwg.convert(dwg);
    const svg = libredwg.dwg_to_svg(db);
    libredwg.dwg_free(dwg);

    return new Response(svg, {
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    return new Response(message, { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}
