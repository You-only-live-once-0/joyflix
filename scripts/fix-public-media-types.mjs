import fs from 'node:fs';

const path = 'src/lib/public-media.ts';
let content = fs.readFileSync(path, 'utf8');
const search = `  const info = page.imageinfo?.[0];
  const mediaUrl = info?.url || '';
  const mime = info?.mime || '';
`;
const replacement = `  const info = page.imageinfo?.[0];
  if (!info) return null;

  const mediaUrl = info.url || '';
  const mime = info.mime || '';
`;
if (!content.includes(search)) {
  throw new Error('Commons image info guard target not found');
}
content = content.replace(search, replacement).replace(
  "poster: info?.thumburl || '/assets/img/poster.png',",
  "poster: info.thumburl || '/assets/img/poster.png',"
);
fs.writeFileSync(path, content);
fs.rmSync('scripts/fix-public-media-types.mjs', { force: true });
fs.rmSync('.github/workflows/fix-public-media-types.yml', { force: true });
