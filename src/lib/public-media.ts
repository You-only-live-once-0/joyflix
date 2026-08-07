import { ApiSite } from '@/lib/config';
import { SearchResult } from '@/lib/types';
import { cleanHtmlTags } from '@/lib/utils';

const ARCHIVE_SEARCH_URL = 'https://archive.org/advancedsearch.php';
const ARCHIVE_METADATA_URL = 'https://archive.org/metadata';
const COMMONS_API_URL = 'https://commons.wikimedia.org/w/api.php';
const PUBLIC_MEDIA_TIMEOUT = 9000;

interface ArchiveSearchDoc {
  identifier?: string;
  title?: string | string[];
  description?: string | string[];
  year?: string | number;
  date?: string;
  subject?: string | string[];
  creator?: string | string[];
  licenseurl?: string | string[];
}

interface ArchiveFile {
  name?: string;
  title?: string;
  format?: string;
  source?: string;
  size?: string | number;
  private?: string | boolean;
}

interface ArchiveMetadataResponse {
  metadata?: Record<string, unknown>;
  files?: ArchiveFile[];
}

interface CommonsImageInfo {
  url?: string;
  thumburl?: string;
  mime?: string;
  size?: number;
  extmetadata?: Record<string, { value?: string }>;
}

interface CommonsPage {
  pageid?: number;
  title?: string;
  imageinfo?: CommonsImageInfo[];
}

interface CommonsResponse {
  query?: {
    pages?: CommonsPage[];
  };
}

function parseAdapter(api: string): {
  kind: string;
  params: URLSearchParams;
} {
  const raw = api.slice('adapter:'.length);
  const separator = raw.indexOf('?');
  const kind = separator >= 0 ? raw.slice(0, separator) : raw;
  const query = separator >= 0 ? raw.slice(separator + 1) : '';
  return { kind, params: new URLSearchParams(query) };
}

export function isPublicMediaAdapter(api: string): boolean {
  return api.startsWith('adapter:internet-archive') || api.startsWith('adapter:wikimedia-commons');
}

async function fetchJson<T>(url: string, timeout = PUBLIC_MEDIA_TIMEOUT): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'JoyFlix/1.0 public-media-adapter',
      },
      next: { revalidate: 3600 },
    });

    if (!response.ok) {
      throw new Error(`Public media request failed: ${response.status}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

function toText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(' · ');
  }
  if (value === null || value === undefined) return '';
  return String(value);
}

function normalizeTitle(value: string): string {
  return value.replace(/^File:/i, '').replace(/.(webm|ogv|ogg|mp4)$/i, '').trim();
}

function normalizeSearch(value: string): string {
  return value.replaceAll(' ', '').toLocaleLowerCase();
}

function safeSearchTerm(value: string): string {
  return value
    .replace(/[^p{L}p{N}s._-]/gu, ' ')
    .replace(/s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function encodeOpaqueId(prefix: 'ia' | 'wc', value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return `${prefix}_${btoa(binary)
    .replace(/+/g, '-')
    .replace(///g, '_')
    .replace(/=+$/g, '')}`;
}

function decodeOpaqueId(id: string, expectedPrefix: 'ia' | 'wc'): string {
  const marker = `${expectedPrefix}_`;
  if (!id.startsWith(marker)) {
    throw new Error('Invalid public media identifier');
  }

  const raw = id.slice(marker.length).replace(/-/g, '+').replace(/_/g, '/');
  const padded = raw.padEnd(Math.ceil(raw.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function getYear(value: unknown, fallback?: unknown): string {
  const match = `${toText(value)} ${toText(fallback)}`.match(/(18|19|20)d{2}/);
  return match?.[0] || 'unknown';
}

function archiveDownloadUrl(identifier: string, fileName: string): string {
  const encodedPath = fileName
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `https://archive.org/download/${encodeURIComponent(identifier)}/${encodedPath}`;
}

function archiveFileScore(file: ArchiveFile): number {
  const name = (file.name || '').toLowerCase();
  const format = (file.format || '').toLowerCase();
  const size = Number(file.size || 0);
  let score = 0;

  if (file.source === 'original') score += 100;
  if (name.endsWith('.mp4')) score += 40;
  if (name.endsWith('.webm')) score += 30;
  if (name.endsWith('.ogv') || name.endsWith('.ogg')) score += 20;
  if (format.includes('h.264') || format.includes('mpeg4')) score += 15;
  if (name.includes('512kb') || name.includes('low')) score -= 15;
  if (size > 50_000_000) score += 5;

  return score;
}

function selectArchiveFiles(files: ArchiveFile[]): ArchiveFile[] {
  const playable = files.filter((file) => {
    const name = file.name || '';
    const lower = name.toLowerCase();
    if (!/.(mp4|webm|ogv|ogg)$/i.test(name)) return false;
    if (/(_thumb|thumbs?|sample|trailer|preview|spectrogram)/i.test(lower)) return false;
    if (file.private === true || file.private === 'true') return false;
    return true;
  });

  const originals = playable.filter((file) => file.source === 'original');
  const candidates = originals.length > 0 ? originals : playable;
  return candidates.sort((a, b) => archiveFileScore(b) - archiveFileScore(a)).slice(0, 12);
}

async function searchInternetArchive(apiSite: ApiSite, query: string): Promise<SearchResult[]> {
  const { params: adapterParams } = parseAdapter(apiSite.api);
  const collection = adapterParams.get('collection') || 'feature_films';
  const term = safeSearchTerm(query);
  if (!term) return [];

  const params = new URLSearchParams({
    q: `collection:${collection} AND mediatype:movies AND (title:"${term}" OR description:"${term}" OR subject:"${term}")`,
    rows: '24',
    page: '1',
    output: 'json',
  });
  ['identifier', 'title', 'description', 'year', 'date', 'subject', 'creator', 'licenseurl'].forEach((field) =>
    params.append('fl[]', field)
  );

  const data = await fetchJson<{ response?: { docs?: ArchiveSearchDoc[] } }>(
    `${ARCHIVE_SEARCH_URL}?${params.toString()}`
  );

  return (data.response?.docs || [])
    .filter((doc) => doc.identifier && doc.title)
    .map((doc) => {
      const identifier = String(doc.identifier);
      return {
        id: encodeOpaqueId('ia', identifier),
        title: toText(doc.title).trim(),
        poster: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
        episodes: [],
        episodes_titles: [],
        source: apiSite.key,
        source_name: apiSite.name,
        class: ['公开授权', toText(doc.subject)].filter(Boolean).join(' · '),
        year: getYear(doc.year, doc.date),
        desc: cleanHtmlTags(toText(doc.description)),
        type_name: '公版与开放授权影片',
        douban_id: 0,
      } satisfies SearchResult;
    });
}

async function getInternetArchiveDetail(apiSite: ApiSite, id: string): Promise<SearchResult> {
  const identifier = decodeOpaqueId(id, 'ia');
  const data = await fetchJson<ArchiveMetadataResponse>(
    `${ARCHIVE_METADATA_URL}/${encodeURIComponent(identifier)}`,
    12000
  );
  const metadata = data.metadata || {};
  const files = selectArchiveFiles(data.files || []);

  if (files.length === 0) {
    throw new Error('该开放影片暂时没有可直接播放的视频文件');
  }

  const title = toText(metadata.title) || identifier;
  const episodes = files.map((file) => archiveDownloadUrl(identifier, file.name || ''));
  const episodesTitles = files.map((file, index) =>
    toText(file.title) || (files.length === 1 ? '正片' : `视频 ${index + 1}`)
  );

  return {
    id,
    title,
    poster: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
    episodes,
    episodes_titles: episodesTitles,
    source: apiSite.key,
    source_name: apiSite.name,
    class: ['公开授权', toText(metadata.subject)].filter(Boolean).join(' · '),
    year: getYear(metadata.year, metadata.date),
    desc: cleanHtmlTags(toText(metadata.description)),
    type_name: '公版与开放授权影片',
    douban_id: 0,
  };
}

function getCommonsDescription(info: CommonsImageInfo): string {
  const metadata = info.extmetadata || {};
  return cleanHtmlTags(
    metadata.ImageDescription?.value || metadata.ObjectName?.value || metadata.Credit?.value || ''
  );
}

function commonsPageToResult(apiSite: ApiSite, page: CommonsPage): SearchResult | null {
  const title = page.title || '';
  const info = page.imageinfo?.[0];
  const mediaUrl = info?.url || '';
  const mime = info?.mime || '';

  if (!title || !mediaUrl || (!mime.startsWith('video/') && !/.(webm|ogv|ogg|mp4)$/i.test(mediaUrl))) {
    return null;
  }

  const metadata = info?.extmetadata || {};
  const license = metadata.LicenseShortName?.value || metadata.UsageTerms?.value || '开放授权';

  return {
    id: encodeOpaqueId('wc', title),
    title: normalizeTitle(title),
    poster: info?.thumburl || '/assets/img/poster.png',
    episodes: [mediaUrl],
    episodes_titles: ['正片'],
    source: apiSite.key,
    source_name: apiSite.name,
    class: `Wikimedia Commons · ${cleanHtmlTags(license)}`,
    year: getYear(metadata.DateTimeOriginal?.value, metadata.DateTime?.value),
    desc: getCommonsDescription(info),
    type_name: '开放授权视频',
    douban_id: 0,
  };
}

async function queryCommons(apiSite: ApiSite, params: URLSearchParams): Promise<SearchResult[]> {
  params.set('action', 'query');
  params.set('prop', 'imageinfo');
  params.set('iiprop', 'url|mime|size|extmetadata');
  params.set('iiurlwidth', '500');
  params.set('format', 'json');
  params.set('formatversion', '2');
  params.set('origin', '*');

  const data = await fetchJson<CommonsResponse>(`${COMMONS_API_URL}?${params.toString()}`);
  return (data.query?.pages || [])
    .map((page) => commonsPageToResult(apiSite, page))
    .filter((item): item is SearchResult => item !== null);
}

async function searchWikimediaCommons(apiSite: ApiSite, query: string): Promise<SearchResult[]> {
  const term = safeSearchTerm(query);
  if (!term) return [];

  return queryCommons(
    apiSite,
    new URLSearchParams({
      generator: 'search',
      gsrsearch: term,
      gsrnamespace: '6',
      gsrlimit: '24',
    })
  );
}

async function getWikimediaCommonsDetail(apiSite: ApiSite, id: string): Promise<SearchResult> {
  const fileTitle = decodeOpaqueId(id, 'wc');
  const results = await queryCommons(apiSite, new URLSearchParams({ titles: fileTitle }));
  const detail = results[0];

  if (!detail) {
    throw new Error('Wikimedia Commons 视频不可用');
  }

  return { ...detail, id };
}

export async function searchPublicMedia(apiSite: ApiSite, query: string): Promise<SearchResult[]> {
  try {
    const { kind } = parseAdapter(apiSite.api);
    if (kind === 'internet-archive') return await searchInternetArchive(apiSite, query);
    if (kind === 'wikimedia-commons') return await searchWikimediaCommons(apiSite, query);
    return [];
  } catch (error) {
    console.warn(`公开资源搜索失败 ${apiSite.name}:`, error);
    return [];
  }
}

export async function getPublicMediaDetail(apiSite: ApiSite, id: string): Promise<SearchResult> {
  const { kind } = parseAdapter(apiSite.api);
  if (kind === 'internet-archive') return getInternetArchiveDetail(apiSite, id);
  if (kind === 'wikimedia-commons') return getWikimediaCommonsDetail(apiSite, id);
  throw new Error('未知的公开资源适配器');
}

export async function searchPublicMediaExact(
  apiSite: ApiSite,
  query: string,
  year: string | null
): Promise<SearchResult | null> {
  const results = await searchPublicMedia(apiSite, query);
  const normalizedQuery = normalizeSearch(query);
  const match =
    results.find(
      (result) =>
        normalizeSearch(result.title) === normalizedQuery && (!year || result.year === year)
    ) ||
    results.find(
      (result) => normalizeSearch(result.title).includes(normalizedQuery) && (!year || result.year === year)
    );

  if (!match) return null;

  try {
    return await getPublicMediaDetail(apiSite, match.id);
  } catch {
    return match.episodes.length > 0 ? match : null;
  }
}
