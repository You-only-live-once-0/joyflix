import fs from 'node:fs';

const path = 'src/lib/public-media.ts';
let content = fs.readFileSync(path, 'utf8');
const target = `      headers: {
        Accept: 'application/json',
        'User-Agent': 'JoyFlix/1.0 public-media-adapter',
      },`;
const replacement = `      headers: {
        Accept: 'application/json',
      },`;

if (!content.includes(target)) {
  throw new Error('Edge request header target not found');
}

content = content.replace(target, replacement);
fs.writeFileSync(path, content);
fs.rmSync('scripts/fix-public-media-fetch.mjs', { force: true });
fs.rmSync('.github/workflows/fix-public-media-fetch.yml', { force: true });
