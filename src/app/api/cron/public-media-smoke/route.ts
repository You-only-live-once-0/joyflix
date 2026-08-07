import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

type ProbeResult = {
  ok: boolean;
  status?: number;
  contentType?: string | null;
  preview?: string;
  error?: string;
};

async function probe(url: string): Promise<ProbeResult> {
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'JoyFlix/1.0 (+https://github.com/You-only-live-once-0/joyflix)',
      },
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get('content-type'),
      preview: text.slice(0, 1200),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function GET() {
  const archiveSimple = new URL('https://archive.org/advancedsearch.php');
  archiveSimple.searchParams.set(
    'q',
    'collection:feature_films AND mediatype:movies AND title:(Night of the Living Dead)'
  );
  archiveSimple.searchParams.set('rows', '5');
  archiveSimple.searchParams.set('page', '1');
  archiveSimple.searchParams.set('output', 'json');
  archiveSimple.searchParams.append('fl[]', 'identifier');
  archiveSimple.searchParams.append('fl[]', 'title');

  const archiveScrape = new URL(
    'https://archive.org/services/search/v1/scrape'
  );
  archiveScrape.searchParams.set(
    'q',
    'collection:feature_films AND mediatype:movies AND title:(Night of the Living Dead)'
  );
  archiveScrape.searchParams.set('count', '5');
  archiveScrape.searchParams.set('fields', 'identifier,title');

  const archiveMetadata =
    'https://archive.org/metadata/night_of_the_living_dead';

  const commons = new URL('https://commons.wikimedia.org/w/api.php');
  commons.searchParams.set('action', 'query');
  commons.searchParams.set('generator', 'search');
  commons.searchParams.set('gsrsearch', 'filetype:video Apollo 11');
  commons.searchParams.set('gsrnamespace', '6');
  commons.searchParams.set('gsrlimit', '10');
  commons.searchParams.set('prop', 'imageinfo');
  commons.searchParams.set('iiprop', 'url|mime|size|extmetadata');
  commons.searchParams.set('iiurlwidth', '500');
  commons.searchParams.set('format', 'json');
  commons.searchParams.set('formatversion', '2');
  commons.searchParams.set('origin', '*');

  const [archiveSimpleResult, archiveScrapeResult, archiveMetadataResult, commonsResult] =
    await Promise.all([
      probe(archiveSimple.toString()),
      probe(archiveScrape.toString()),
      probe(archiveMetadata),
      probe(commons.toString()),
    ]);

  return NextResponse.json({
    archiveSimple: archiveSimpleResult,
    archiveScrape: archiveScrapeResult,
    archiveMetadata: archiveMetadataResult,
    commons: commonsResult,
  });
}
