import { NextResponse } from 'next/server';

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
