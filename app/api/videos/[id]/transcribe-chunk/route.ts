import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getVideo } from '@/lib/video-store';
import { fetchAudioFormat } from '@/lib/youtube';
import { ai } from '@/lib/openai';
import { env } from '@/lib/env';
import { db } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 300;

const MEDIA_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

function runFfmpeg(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg binary is unavailable in this deployment.'));
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else {
        const safeDetail = stderr
          .slice(-1200)
          .replace(/https?:\/\/\S+/gi, '[redacted URL]')
          .replace(env.youtubeProxyUrl || /$^/, '[redacted proxy]');
        reject(new Error(`Audio conversion failed${safeDetail ? `: ${safeDetail}` : ''}`));
      }
    });
  });
}

function mediaHeaders() {
  const lines = [
    'Referer: https://www.youtube.com/',
    'Origin: https://www.youtube.com',
  ];
  if (env.youtubeCookie) lines.push(`Cookie: ${env.youtubeCookie}`);
  return `${lines.join('\r\n')}\r\n`;
}

function browserSafeError(message: string) {
  if (/HTTP error 403|Server returned 403|403 Forbidden/i.test(message)) {
    return 'YouTube rejected the protected audio download (HTTP 403). Full diagnostics were written to Vercel Runtime Logs.';
  }
  if (message.length > 420) return `${message.slice(0, 417)}...`;
  return message;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (auth) return auth;
  const { id } = await ctx.params;
  let outputPath = '';
  try {
    const body = await req.json();
    const index = Number(body.index);
    const chunkSeconds = Number(body.chunkSeconds || 480);
    if (!Number.isInteger(index) || index < 0) return NextResponse.json({ error: 'Invalid chunk index' }, { status: 400 });
    if (!Number.isFinite(chunkSeconds) || chunkSeconds < 30 || chunkSeconds > 900) return NextResponse.json({ error: 'Invalid chunk duration' }, { status: 400 });

    const video = await getVideo(id);
    const start = index * chunkSeconds;
    if (video.duration_seconds && start >= video.duration_seconds) {
      return NextResponse.json({ error: 'Chunk starts beyond video duration' }, { status: 400 });
    }
    const duration = video.duration_seconds ? Math.min(chunkSeconds, video.duration_seconds - start) : chunkSeconds;

    const audio = await fetchAudioFormat(video.url);
    outputPath = path.join(os.tmpdir(), `yt-${id}-${index}-${Date.now()}.mp3`);
    const proxyArgs = env.youtubeProxyUrl ? ['-http_proxy', env.youtubeProxyUrl] : [];
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(start),
      '-user_agent', MEDIA_UA,
      '-headers', mediaHeaders(),
      ...proxyArgs,
      '-i', audio.url,
      '-t', String(duration),
      '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k',
      '-f', 'mp3', '-y', outputPath,
    ]);

    const stat = await fs.promises.stat(outputPath);
    if (stat.size <= 0) throw new Error('Audio chunk was empty.');

    const transcription = await ai().audio.transcriptions.create({
      file: fs.createReadStream(outputPath),
      model: env.transcribeModel,
    });
    const text = typeof transcription === 'string' ? transcription : transcription.text;
    if (!text?.trim()) throw new Error('OpenAI returned an empty transcription for this chunk.');

    const { error } = await db().from('transcript_chunks').upsert({
      video_id: id,
      chunk_index: index,
      text: text.trim(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'video_id,chunk_index' });
    if (error) throw error;

    return NextResponse.json({ ok: true, index, seconds: duration });
  } catch (error) {
    // Keep the browser response concise enough for the queue UI, but preserve the
    // complete diagnostic in Vercel Runtime Logs (including all attempted clients).
    console.error(`[transcribe-chunk] video=${id}`, error);
    const message = error instanceof Error ? error.message : 'Audio transcription failed';
    const hostingHint = /timeout|timed out|FUNCTION_INVOCATION_TIMEOUT/i.test(message)
      ? ' Vercel Hobby execution limits were reached for this chunk.' : '';
    return NextResponse.json({ error: `${browserSafeError(message)}${hostingHint}` }, { status: 422 });
  } finally {
    if (outputPath) fs.promises.unlink(outputPath).catch(() => {});
  }
}
