import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { expandPlaylist, extractYoutubeId } from '@/lib/youtube';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: Request) {
  const auth = await requireAuth();
  if (auth) return auth;
  try {
    const body = await req.json();
    const inputs = Array.isArray(body.urls) ? body.urls : [];
    const urls: string[] = [];
    for (const raw of inputs.slice(0, 100)) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const trimmed = raw.trim();
      let parsed: URL;
      try { parsed = new URL(trimmed); } catch { throw new Error(`Invalid URL: ${trimmed}`); }
      if (!(parsed.hostname === 'youtu.be' || parsed.hostname.endsWith('youtube.com'))) {
        throw new Error('Version 1 supports YouTube URLs only.');
      }
      if (parsed.searchParams.get('list')) urls.push(...await expandPlaylist(trimmed));
      else if (extractYoutubeId(trimmed)) urls.push(trimmed);
      else throw new Error(`Could not identify a YouTube video: ${trimmed}`);
    }
    const deduped = [...new Set(urls)].slice(0, 500);
    return NextResponse.json({ urls: deduped });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not expand URLs' }, { status: 400 });
  }
}
