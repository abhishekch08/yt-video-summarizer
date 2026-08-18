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

class CaptionAccessError extends Error {
  constructor(
    message: string,
    readonly diagnostics: string[],
    readonly metadata?: YoutubeMetadata,
  ) {
    super(message);
    this.name = 'CaptionAccessError';
  }
}

function youtubeFetch(input: string | URL | Request, init?: RequestInit) {
  return fetch(input, init);
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

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
  const res = await youtubeFetch(url, { headers: requestHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(`YouTube watch page returned HTTP ${res.status}`);
  return res.text();
}

function selectCaptionTrack(tracks: any[]) {
  const scored = tracks.map((t) => {
    const lang = String(t.languageCode || t.language_code || '').toLowerCase();
    const rawName = t.name?.simpleText ?? t.name?.toString?.() ?? t.name ?? '';
    const name = String(rawName);
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

function transcriptFromJson3(body: string) {
  const data = JSON.parse(body);
  const pieces: string[] = [];
  for (const event of data.events || []) {
    const text = (event.segs || []).map((seg: any) => seg.utf8 || '').join('');
    if (text.trim()) pieces.push(text);
  }
  return cleanTranscript(pieces);
}

function jinaCaptionUrl(captionUrl: URL) {
  return `https://r.jina.ai/http://${captionUrl.host}${captionUrl.pathname}${captionUrl.search}`;
}

async function fetchCaptionText(baseUrl: string) {
  const diagnostics: string[] = [];
  const jsonUrl = new URL(baseUrl);
  jsonUrl.searchParams.set('fmt', 'json3');

  try {
    const res = await youtubeFetch(jsonUrl, { headers: requestHeaders(), cache: 'no-store' });
    const body = await res.text();
    if (res.ok && body.trim()) {
      try {
        const cleaned = transcriptFromJson3(body);
        if (cleaned) return cleaned;
      } catch (error) {
        diagnostics.push(`json3 parse: ${safeErrorMessage(error)}`);
      }
    } else {
      diagnostics.push(`json3 HTTP ${res.status}, ${body.length} bytes`);
    }
  } catch (error) {
    diagnostics.push(`json3 request: ${safeErrorMessage(error)}`);
  }

  try {
    const xmlRes = await youtubeFetch(baseUrl, { headers: requestHeaders(), cache: 'no-store' });
    const xml = await xmlRes.text();
    if (xmlRes.ok && xml.trim()) {
      const pieces = Array.from(xml.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)).map((m) => decodeHtml(m[1]));
      const cleaned = cleanTranscript(pieces);
      if (cleaned) return cleaned;
    }
    diagnostics.push(`xml HTTP ${xmlRes.status}, ${xml.length} bytes`);
  } catch (error) {
    diagnostics.push(`xml request: ${safeErrorMessage(error)}`);
  }

  // YouTube frequently returns an empty caption body to Vercel IPs even though the
  // signed track URL is valid. Jina Reader is a free, keyless relay; it fetches that
  // already-authorized public caption URL and returns the JSON as plain text.
  // Do not relay authenticated caption URLs supplied with a user's YouTube cookie.
  if (!env.youtubeCookie) {
    try {
      const relayRes = await fetch(jinaCaptionUrl(jsonUrl), {
        headers: { accept: 'text/plain' },
        cache: 'no-store',
        signal: AbortSignal.timeout(45_000),
      });
      const relayBody = await relayRes.text();
      if (relayRes.ok && relayBody.trim()) {
        const marker = relayBody.indexOf('Markdown Content:');
        const payload = marker >= 0 ? relayBody.slice(marker + 'Markdown Content:'.length) : relayBody;
        const start = payload.indexOf('{');
        const end = payload.lastIndexOf('}');
        if (start >= 0 && end > start) {
          const cleaned = transcriptFromJson3(payload.slice(start, end + 1));
          if (cleaned) return cleaned;
        }
        diagnostics.push(`free relay returned ${relayBody.length} bytes without usable JSON3 captions`);
      } else {
        diagnostics.push(`free relay HTTP ${relayRes.status}, ${relayBody.length} bytes`);
      }
    } catch (error) {
      diagnostics.push(`free relay request: ${safeErrorMessage(error)}`);
    }
  }

  throw new CaptionAccessError(
    'YouTube advertised captions for this video but did not return the caption text.',
    diagnostics,
  );
}

let youtubeClient: Promise<Innertube> | null = null;

async function getYoutubeClient() {
  if (!youtubeClient) {
    youtubeClient = Innertube.create({
      cookie: env.youtubeCookie,
      cache: new UniversalCache(false),
      generate_session_locally: true,
      fetch: youtubeFetch,
    });
  }
  return youtubeClient;
}

async function fetchViaInnertube(videoId: string): Promise<CaptionResult> {
  const youtube = await getYoutubeClient();
  const clients = ['WEB', 'IOS'] as const;
  let fallbackMetadata: YoutubeMetadata | null = null;
  const failures: string[] = [];

  for (const client of clients) {
    try {
      const info: any = await youtube.getInfo(videoId, { client });
      const playability = info.playability_status;
      if (playability?.status && !['OK', 'LIVE_STREAM_OFFLINE'].includes(playability.status)) {
        const reason = playability.reason || playability.messages?.join?.(' ') || playability.status;
        throw new Error(`YouTube internal API access error: ${reason}`);
      }

      const basic = info.basic_info || {};
      const metadata: YoutubeMetadata = {
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: basic.title || `YouTube video ${videoId}`,
        channel: basic.channel?.name || basic.author || null,
        durationSeconds: Number.isFinite(Number(basic.duration)) ? Number(basic.duration) : null,
      };
      if (basic.title || metadata.durationSeconds !== null) fallbackMetadata = metadata;

      const directTracks: any[] = info.captions?.caption_tracks || [];
      if (directTracks.length) {
        const track = selectCaptionTrack(directTracks);
        const baseUrl = track?.base_url || track?.baseUrl;
        if (baseUrl) {
          try {
            const transcript = await fetchCaptionText(baseUrl);
            return {
              metadata,
              transcript,
              captionLanguage: track.language_code || track.languageCode || undefined,
            };
          } catch (error) {
            if (error instanceof CaptionAccessError) {
              failures.push(`${client} captions: ${error.diagnostics.join(', ')}`);
            } else {
              failures.push(`${client} captions: ${safeErrorMessage(error)}`);
            }
          }
        }
      }

      if (client === 'WEB') {
        try {
          let transcriptInfo: any = await info.getTranscript();
          const english = (transcriptInfo.languages || []).find((name: string) => /^english\b/i.test(name));
          if (english && !/^english\b/i.test(transcriptInfo.selectedLanguage || '')) {
            try { transcriptInfo = await transcriptInfo.selectLanguage(english); } catch {}
          }

          const segments: any[] = transcriptInfo.transcript?.content?.body?.initial_segments || [];
          const pieces = segments
            .map((segment: any) => segment?.snippet?.toString?.() || String(segment?.snippet || ''))
            .filter((text: string) => text.trim());
          const transcript = cleanTranscript(pieces);
          if (transcript) {
            return {
              metadata,
              transcript,
              captionLanguage: transcriptInfo.selectedLanguage || undefined,
            };
          }
        } catch (error) {
          failures.push(`WEB transcript API: ${safeErrorMessage(error)}`);
        }
      }
    } catch (error) {
      failures.push(`${client} player: ${safeErrorMessage(error)}`);
    }
  }

  if (failures.some((failure) => failure.includes('captions:'))) {
    console.error(`[youtube-captions] video=${videoId}`, failures);
    throw new CaptionAccessError(
      'YouTube captions were detected but could not be fetched from this deployment.',
      failures,
      fallbackMetadata || undefined,
    );
  }

  if (fallbackMetadata) return { metadata: fallbackMetadata, transcript: null };
  throw new Error(`YouTube internal API returned no usable video metadata. ${failures.join(' | ')}`);
}

async function fetchViaWatchPage(videoId: string): Promise<CaptionResult> {
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
  try {
    const transcript = await fetchCaptionText(track.baseUrl);
    return { metadata, transcript: transcript || null, captionLanguage: track.languageCode };
  } catch (error) {
    if (error instanceof CaptionAccessError) {
      throw new CaptionAccessError(error.message, error.diagnostics, metadata);
    }
    throw error;
  }
}

async function fetchOEmbedMetadata(inputUrl: string, videoId: string): Promise<YoutubeMetadata> {
  try {
    const url = new URL('https://www.youtube.com/oembed');
    url.searchParams.set('url', inputUrl);
    url.searchParams.set('format', 'json');
    const response = await fetch(url, { cache: 'no-store' });
    const body = response.ok ? await response.json() as any : null;
    return {
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: body?.title || `YouTube video ${videoId}`,
      channel: body?.author_name || null,
      durationSeconds: null,
    };
  } catch {
    return {
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: `YouTube video ${videoId}`,
      channel: null,
      durationSeconds: null,
    };
  }
}

export async function fetchCaptionsAndMetadata(inputUrl: string): Promise<CaptionResult> {
  const videoId = extractYoutubeId(inputUrl);
  if (!videoId) throw new Error('Invalid YouTube video URL');

  let innerResult: CaptionResult | null = null;
  let innerError: unknown = null;
  try {
    innerResult = await fetchViaInnertube(videoId);
    if (innerResult.transcript) return innerResult;
  } catch (error) {
    innerError = error;
  }

  let pageResult: CaptionResult | null = null;
  let pageError: unknown = null;
  try {
    pageResult = await fetchViaWatchPage(videoId);
    if (pageResult.transcript) return pageResult;
  } catch (error) {
    pageError = error;
    if (error instanceof CaptionAccessError) {
      console.error(`[youtube-captions-page] video=${videoId}`, error.diagnostics);
    }
  }

  const metadata = innerResult?.metadata
    || pageResult?.metadata
    || (innerError instanceof CaptionAccessError ? innerError.metadata : undefined)
    || (pageError instanceof CaptionAccessError ? pageError.metadata : undefined)
    || await fetchOEmbedMetadata(inputUrl, videoId);

  if (innerResult || pageResult) return innerResult || pageResult!;

  if (innerError instanceof CaptionAccessError || pageError instanceof CaptionAccessError) {
    const diagnostics = [innerError, pageError]
      .filter((error): error is CaptionAccessError => error instanceof CaptionAccessError)
      .flatMap((error) => error.diagnostics);
    console.error(`[youtube-captions] video=${videoId}`, diagnostics);
    throw new Error('YouTube captions were detected, but both direct access and the free caption relay failed. Please retry shortly.');
  }

  const failures = [innerError, pageError].filter(Boolean).map(safeErrorMessage).join(' | ');
  if (failures) console.error(`[youtube-access] video=${videoId}`, failures);
  return { metadata, transcript: null };
}

export async function fetchAudioFormat(videoUrl: string) {
  const videoId = extractYoutubeId(videoUrl);
  if (!videoId) throw new Error('Invalid YouTube video URL');
  const youtube = await getYoutubeClient();
  const clients = ['IOS', 'ANDROID_VR', 'TV', 'WEB_EMBEDDED', 'WEB'] as const;
  const failures: string[] = [];

  for (const client of clients) {
    try {
      const format: any = await youtube.getStreamingData(videoId, {
        type: 'audio',
        quality: 'best',
        client,
      } as any);
      if (format?.url) {
        return {
          url: format.url,
          mimeType: format.mime_type || 'audio/webm',
          durationSeconds: null,
        };
      }
      failures.push(`${client}: no URL`);
    } catch (error) {
      failures.push(`${client}: ${safeErrorMessage(error)}`);
    }
  }

  console.error(`[youtube-audio] video=${videoId}`, failures);
  throw new Error('YouTube did not provide a downloadable audio stream. This video has no usable captions, so automatic transcription cannot continue from this deployment.');
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
  const res = await youtubeFetch(playlistUrl, { headers: requestHeaders(), cache: 'no-store' });
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
