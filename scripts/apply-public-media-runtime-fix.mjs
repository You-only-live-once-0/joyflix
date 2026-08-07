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

{
  const path = 'src/lib/public-media.ts';
  let content = read(path);
  content = replaceOnce(
    content,
    `      headers: {
        Accept: 'application/json',
      },`,
    `      headers: {
        Accept: 'application/json',
        'User-Agent':
          'JoyFlix/1.0 (+https://github.com/You-only-live-once-0/joyflix)',
      },`,
    'public media user agent'
  );
  content = replaceOnce(
    content,
    `      gsrsearch: term,`,
    `      gsrsearch: \`filetype:video \${term}\`,`,
    'Wikimedia video filter'
  );
  write(path, content);
}

for (const path of [
  'src/app/api/search/route.ts',
  'src/app/api/search/stream/route.ts',
  'src/app/api/detail/route.ts',
]) {
  let content = read(path);
  content = replaceOnce(
    content,
    `export const runtime = 'edge';`,
    `export const runtime = 'nodejs';`,
    `${path} runtime`
  );
  write(path, content);
}

write(
  'src/app/api/cron/public-media-smoke/route.ts',
  `import { NextResponse } from 'next/server';

import {
  getPublicMediaDetail,
  searchPublicMedia,
} from '@/lib/public-media';

export const runtime = 'nodejs';

export async function GET() {
  const featureSite = {
    key: 'ia_feature_films',
    name: 'Internet Archive 公版电影',
    api: 'adapter:internet-archive?collection=feature_films',
  };
  const prelingerSite = {
    key: 'ia_prelinger',
    name: 'Prelinger 历史影像',
    api: 'adapter:internet-archive?collection=prelinger',
  };
  const commonsSite = {
    key: 'wikimedia_commons',
    name: 'Wikimedia Commons 开放视频',
    api: 'adapter:wikimedia-commons',
  };

  const [featureResults, prelingerResults, commonsResults] = await Promise.all([
    searchPublicMedia(featureSite, 'Night of the Living Dead'),
    searchPublicMedia(prelingerSite, 'Duck and Cover'),
    searchPublicMedia(commonsSite, 'Apollo 11'),
  ]);

  const archiveCandidate = featureResults[0] || prelingerResults[0];
  const archiveSite = featureResults[0] ? featureSite : prelingerSite;
  const archiveDetail = archiveCandidate
    ? await getPublicMediaDetail(archiveSite, archiveCandidate.id)
    : null;
  const commonsDetail = commonsResults[0]
    ? await getPublicMediaDetail(commonsSite, commonsResults[0].id)
    : null;

  return NextResponse.json({
    ok:
      Boolean(archiveDetail?.episodes.length) &&
      Boolean(commonsDetail?.episodes.length),
    featureFilms: {
      count: featureResults.length,
      firstTitle: featureResults[0]?.title || null,
    },
    prelinger: {
      count: prelingerResults.length,
      firstTitle: prelingerResults[0]?.title || null,
    },
    commons: {
      count: commonsResults.length,
      firstTitle: commonsResults[0]?.title || null,
    },
    archivePlayableFiles: archiveDetail?.episodes.length || 0,
    commonsPlayableFiles: commonsDetail?.episodes.length || 0,
  });
}
`
);

fs.rmSync('scripts/apply-public-media-runtime-fix.mjs', { force: true });
fs.rmSync('.github/workflows/apply-public-media-runtime-fix.yml', {
  force: true,
});
