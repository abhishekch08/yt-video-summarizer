import { Innertube, Platform, Types, UniversalCache } from 'youtubei.js';
import { env } from '@/lib/env';
import { cleanTranscript, decodeHtml } from '@/lib/text';
import { mintYoutubeContentPoToken } from '@/lib/youtube-potoken';

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

// Current YouTube.js uses its platform shim when deciphering protected media URLs.
// The official BgUtils + YouTube.js Node example provides an eval implementation.
Platform.shim.eval = async (data: Types.BuildScriptResult) => new Function(data.output)();

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

let youtubeClient: Promise<Innertube> | null = null;

async function getYoutubeClient() {
  if (!youtubeClient) {
    youtubeClient = Innertube.create({
      cookie: env.youtubeCookie,
      cache: new UniversalCache(false),
      generate_session_locally: true,
    });
  }
  return youtubeClient;
}

function metadataFromInfo(videoId: string, info: any): YoutubeMetadata {
  const basic = info?.basic_info || {};
  const duration = Number(basic.duration);
  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: basic.title || `YouTube video ${videoId}`,
    channel: basic.channel?.name || basic.author || null,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
  };
}

function assertPlayable(info: any, prefix: string) {
  const playability = info?.playability_status;
  if (playability?.status && !['OK', 'LIVE_STREAM_OFFLINE'].includes(playability.status)) {
    const reason = playability.reason || playability.messages?.join?.(' ') || playability.status;
    throw new Error(`${prefix}: ${reason}`);
  }
}

async function transcriptFromInfo(info: any, metadata: YoutubeMetadata): Promise<CaptionResult | null> {
  const directTracks: any[] = info.captions?.caption_tracks || [];
  if (directTracks.length) {
    const track = selectCaptionTrack(directTracks);
    const baseUrl = track?.base_url || track?.baseUrl;
    if (baseUrl) {
      try {
        const transcript = await fetchCaptionText(baseUrl);
        if (transcript) {
          return {
            metadata,
            transcript,
            captionLanguage: track.language_code || track.languageCode || undefined,
          };
        }
      } catch {
        // Continue to the engagement-panel transcript API.
      }
    }
  }

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
  } catch {
    // A video may genuinely have no searchable transcript panel.
  }

  return null;
}

async function fetchViaInnertube(videoId: string): Promise<CaptionResult> {
  const youtube = await getYoutubeClient();
  const info: any = await youtube.getInfo(videoId);
  assertPlayable(info, 'YouTube internal API access error');

  const metadata = metadataFromInfo(videoId, info);
  const captionResult = await transcriptFromInfo(info, metadata);
  if (captionResult) return captionResult;

  if (metadata.title === `YouTube video ${videoId}` && metadata.durationSeconds === null) {
    throw new Error('YouTube internal API returned no usable video metadata');
  }
  return { metadata, transcript: null };
}

async function fetchViaPoToken(videoId: string): Promise<CaptionResult> {
  const youtube = await getYoutubeClient();
  const poToken = await mintYoutubeContentPoToken(videoId);
  const clients = ['YTMUSIC', 'WEB', 'WEB_EMBEDDED'] as const;
  const failures: string[] = [];
  let bestMetadata: YoutubeMetadata | null = null;

  for (const client of clients) {
    try {
      const info: any = await youtube.getInfo(videoId, { client, po_token: poToken } as any);
      assertPlayable(info, `${client} protected player`);
      const metadata = metadataFromInfo(videoId, info);
      if (!bestMetadata || metadata.durationSeconds) bestMetadata = metadata;
      const captionResult = await transcriptFromInfo(info, metadata);
      if (captionResult) return captionResult;
    } catch (error) {
      failures.push(`${client}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (bestMetadata) return { metadata: bestMetadata, transcript: null };
  throw new Error(`Protected YouTube player returned no usable metadata. ${failures.join(' | ')}`);
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
    durationSeconds: Number.isFinite(Number(vd.lengthSeconds)) && Number(vd.lengthSeconds) > 0 ? Number(vd.lengthSeconds) : null,
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

export async function fetchCaptionsAndMetadata(inputUrl: string): Promise<CaptionResult> {
  const videoId = extractYoutubeId(inputUrl);
  if (!videoId) throw new Error('Invalid YouTube video URL');

  const failures: string[] = [];
  let normalResult: CaptionResult | null = null;

  try {
    normalResult = await fetchViaInnertube(videoId);
    if (normalResult.transcript) return normalResult;
  } catch (error) {
    failures.push(`Internal API: ${error instanceof Error ? error.message : String(error)}`);
  }

  // If normal caption discovery did not succeed, retry through a current content-bound
  // WebPO token before declaring the video captionless or moving to audio transcription.
  try {
    const protectedResult = await fetchViaPoToken(videoId);
    if (protectedResult.transcript) return protectedResult;
    if (protectedResult.metadata.durationSeconds) return protectedResult;
  } catch (error) {
    failures.push(`PoToken player: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (normalResult?.metadata.durationSeconds) return normalResult;

  try {
    return await fetchViaWatchPage(videoId);
  } catch (error) {
    failures.push(`Watch page: ${error instanceof Error ? error.message : String(error)}`);
  }

  throw new Error(`YouTube access failed. ${failures.join(' | ')}`);
}

export async function fetchAudioFormat(videoUrl: string) {
  const videoId = extractYoutubeId(videoUrl);
  if (!videoId) throw new Error('Invalid YouTube video URL');
  const youtube = await getYoutubeClient();
  const failures: string[] = [];

  // Primary path: YouTube's current WebPO flow. BgUtils' current reference example
  // mints a token bound to the video ID, requests player data, deciphers the chosen
  // audio format, then appends the same token to the media URL.
  try {
    const poToken = await mintYoutubeContentPoToken(videoId);
    const protectedClients = ['YTMUSIC', 'WEB', 'WEB_EMBEDDED'] as const;

    for (const client of protectedClients) {
      try {
        const info: any = await youtube.getBasicInfo(videoId, { client, po_token: poToken } as any);
        assertPlayable(info, `${client} protected player`);
        if (!info.streaming_data) throw new Error('Streaming data not available');

        const format: any = info.chooseFormat({
          quality: 'best',
          type: 'audio',
        });
        let url = await format.decipher(youtube.session.player);
        if (!url) throw new Error('Audio URL decipher returned empty result');
        const separator = url.includes('?') ? '&' : '?';
        if (!/[?&]pot=/.test(url)) url = `${url}${separator}pot=${encodeURIComponent(poToken)}`;

        return {
          url,
          mimeType: format.mime_type || 'audio/webm',
          durationSeconds: null,
        };
      } catch (error) {
        failures.push(`${client}+PoToken: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    failures.push(`PoToken: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Secondary compatibility path. Some videos/regions still expose media data without
  // WebPO on another official InnerTube client, so retain these cheap fallbacks.
  const legacyClients = ['WEB', 'ANDROID_VR', 'IOS', 'TV', 'WEB_EMBEDDED'] as const;
  for (const client of legacyClients) {
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
      failures.push(`${client}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`No downloadable YouTube audio stream was available. ${failures.join(' | ')}`);
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
    ids = await expandPlaylistFromPage(listId);
  }

  if (!ids.length) throw new Error('No videos could be extracted from this playlist. It may be private or require authentication.');
  return ids.map((id) => `https://www.youtube.com/watch?v=${id}`);
}
