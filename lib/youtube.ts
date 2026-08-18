import { Innertube, UniversalCache } from 'youtubei.js';
import { env } from '@/lib/env';
import { cleanTranscript, decodeHtml } from '@/lib/text';

export interface YoutubeMetadata {
  videoId: string;
  url: string;
  title: string;
  channel: string | null;
  durationSeconds: number | null;
}

export interface CaptionResult {
  metadata: YoutubeMetadata;
  transcript: string | null;
  captionLanguage?: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

function requestHeaders() {
  const headers: Record<string, string> = {
    'user-agent': UA,
    'accept-language': 'en-US,en;q=0.9',
  };
  if (env.youtubeCookie) headers.cookie = env.youtubeCookie;
  return headers;
}

export function extractYoutubeId(input: string) {
  try {
    const url = new URL(input.trim());
    if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('/')[0] || null;
    if (url.hostname.endsWith('youtube.com')) {
      if (url.pathname === '/watch') return url.searchParams.get('v');
      const shorts = url.pathname.match(/^\/shorts\/([^/?]+)/);
      if (shorts) return shorts[1];
      const live = url.pathname.match(/^\/live\/([^/?]+)/);
      if (live) return live[1];
      const embed = url.pathname.match(/^\/embed\/([^/?]+)/);
      if (embed) return embed[1];
    }
  } catch {}
  return null;
}

function extractAssignedJson(html: string, marker: string) {
  const idx = html.indexOf(marker);
  if (idx < 0) return null;
  const eq = html.indexOf('=', idx + marker.length);
  const start = html.indexOf('{', eq >= 0 ? eq : idx + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

async function fetchWatchPage(videoId: string) {
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en&bpctr=9999999999`;
  const res = await fetch(url, { headers: requestHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(`YouTube watch page returned HTTP ${res.status}`);
  return res.text();
}

function selectCaptionTrack(tracks: any[]) {
  const scored = tracks.map((t) => {
    const lang = String(t.languageCode || '').toLowerCase();
    const name = String(t.name?.simpleText || '');
    const manual = t.kind !== 'asr';
    let score = 0;
    if (lang === 'en' || lang.startsWith('en-')) score += 100;
    if (manual) score += 20;
    if (/english/i.test(name)) score += 10;
    return { track: t, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.track || null;
}

async function fetchCaptionText(baseUrl: string) {
  const jsonUrl = baseUrl.includes('fmt=') ? baseUrl.replace(/([?&])fmt=[^&]*/i, '$1fmt=json3') : `${baseUrl}&fmt=json3`;
  const res = await fetch(jsonUrl, { headers: requestHeaders(), cache: 'no-store' });
  if (res.ok) {
    const body = await res.text();
    try {
      const data = JSON.parse(body);
      const pieces: string[] = [];
      for (const event of data.events || []) {
        const text = (event.segs || []).map((seg: any) => seg.utf8 || '').join('');
        if (text.trim()) pieces.push(text);
      }
      const cleaned = cleanTranscript(pieces);
      if (cleaned) return cleaned;
    } catch {}
  }

  const xmlRes = await fetch(baseUrl, { headers: requestHeaders(), cache: 'no-store' });
  if (!xmlRes.ok) throw new Error(`Caption fetch returned HTTP ${xmlRes.status}`);
  const xml = await xmlRes.text();
  const pieces = Array.from(xml.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)).map((m) => decodeHtml(m[1]));
  return cleanTranscript(pieces);
}

export async function fetchCaptionsAndMetadata(inputUrl: string): Promise<CaptionResult> {
  const videoId = extractYoutubeId(inputUrl);
  if (!videoId) throw new Error('Invalid YouTube video URL');
  const html = await fetchWatchPage(videoId);
  const player = extractAssignedJson(html, 'ytInitialPlayerResponse');
  if (!player) throw new Error('Could not read YouTube player metadata. The video may require authentication or YouTube may have blocked the request.');

  const vd = player.videoDetails || {};
  const metadata: YoutubeMetadata = {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: vd.title || `YouTube video ${videoId}`,
    channel: vd.author || null,
    durationSeconds: Number.isFinite(Number(vd.lengthSeconds)) ? Number(vd.lengthSeconds) : null,
  };

  const playability = player.playabilityStatus;
  if (playability?.status && !['OK', 'LIVE_STREAM_OFFLINE'].includes(playability.status)) {
    const reason = playability.reason || playability.messages?.join(' ') || playability.status;
    throw new Error(`YouTube access error: ${reason}`);
  }

  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) return { metadata, transcript: null };

  const track = selectCaptionTrack(tracks);
  if (!track?.baseUrl) return { metadata, transcript: null };
  const transcript = await fetchCaptionText(track.baseUrl);
  return { metadata, transcript: transcript || null, captionLanguage: track.languageCode };
}

let youtubeClient: Promise<Innertube> | null = null;

async function getYoutubeClient() {
  if (!youtubeClient) {
    youtubeClient = Innertube.create({
      cookie: env.youtubeCookie,
      cache: new UniversalCache(false),
    });
  }
  return youtubeClient;
}

export async function fetchAudioFormat(videoUrl: string) {
  const videoId = extractYoutubeId(videoUrl);
  if (!videoId) throw new Error('Invalid YouTube video URL');
  const youtube = await getYoutubeClient();
  const format = await youtube.getStreamingData(videoId, {
    type: 'audio',
    quality: 'best',
  } as any);
  if (!format?.url) throw new Error('No downloadable audio stream was available for this video.');
  return {
    url: format.url,
    mimeType: format.mime_type || 'audio/webm',
    durationSeconds: null,
  };
}

function walkForPlaylistIds(node: unknown, out: string[]) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const v of node) walkForPlaylistIds(v, out);
    return;
  }
  const obj = node as Record<string, any>;
  const id = obj.playlistVideoRenderer?.videoId || obj.playlistPanelVideoRenderer?.videoId;
  if (typeof id === 'string' && id.length >= 6) out.push(id);
  for (const value of Object.values(obj)) walkForPlaylistIds(value, out);
}

async function expandPlaylistWithInnertube(listId: string) {
  const youtube = await getYoutubeClient();
  let page: any = await youtube.getPlaylist(listId);
  const ids: string[] = [];

  while (page && ids.length < 500) {
    for (const item of Array.from(page.items || []) as any[]) {
      const id = item?.id || item?.endpoint?.payload?.videoId;
      if (typeof id === 'string' && id.length >= 6) ids.push(id);
    }
    if (!page.has_continuation || ids.length >= 500) break;
    page = await page.getContinuation();
  }

  return [...new Set(ids)].slice(0, 500);
}

async function expandPlaylistFromPage(listId: string) {
  const playlistUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}&hl=en`;
  const res = await fetch(playlistUrl, { headers: requestHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(`Playlist fetch returned HTTP ${res.status}`);
  const html = await res.text();
  const initial = extractAssignedJson(html, 'ytInitialData');
  const ids: string[] = [];
  if (initial) walkForPlaylistIds(initial, ids);

  if (!ids.length) {
    for (const match of html.matchAll(/"videoId":"([A-Za-z0-9_-]{6,})"/g)) ids.push(match[1]);
  }
  return [...new Set(ids)].slice(0, 500);
}

export async function expandPlaylist(inputUrl: string) {
  const url = new URL(inputUrl);
  const listId = url.searchParams.get('list');
  if (!listId) return [inputUrl];

  let ids: string[] = [];
  try {
    ids = await expandPlaylistWithInnertube(listId);
  } catch {
    // Keep an independent page-parser fallback so a library/parser regression does not
    // make all playlist URLs unusable at once.
    ids = await expandPlaylistFromPage(listId);
  }

  if (!ids.length) throw new Error('No videos could be extracted from this playlist. It may be private or require authentication.');
  return ids.map((id) => `https://www.youtube.com/watch?v=${id}`);
}
