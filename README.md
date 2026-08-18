# Video Summary

A private, mobile-first YouTube summarizer designed for Vercel Hobby + Supabase Free, with OpenAI as the only paid API.

## What it does

- Paste one YouTube URL, several URLs, or a playlist.
- Processes videos **one at a time**.
- Retrieves creator or auto-generated captions first.
- Aggressively cleans caption noise without intentionally changing meaning.
- If captions are unavailable, downloads audio in small time windows and transcribes each window with OpenAI.
- Streams an English summary live in a ChatGPT-like dark UI.
- Summary structure adapts to technical, finance, tutorial, interview, news, educational, or general content.
- Summary depth: **Concise / Standard / Detailed**; Standard is default.
- Summary is transcript-only: no web search, no outside fact checking, no timestamps.
- Saves title, URL, metadata, summaries and raw transcript in Supabase.
- Raw transcript expires after **90 days**; summaries remain until manually deleted.
- Follow-up Q&A is on-demand only. If an expired transcript is needed, the app automatically tries to retrieve/transcribe it again.
- History supports search, date filter and video-type filter. No thumbnails.
- Copy summary or download `.md` / `.txt`.
- One private masked PIN protects the app.

## Stack

- Next.js 16 / React 19
- Vercel Hobby
- Supabase Free Postgres
- OpenAI Responses API (`gpt-5-mini` by default)
- `gpt-5-nano` for cheap content classification
- `gpt-4o-mini-transcribe` for audio fallback
- `youtubei.js` + bundled `ffmpeg-static` for chunked audio extraction

## 1. Create Supabase project

1. Create a free Supabase project.
2. Open **SQL Editor**.
3. Paste and run [`supabase/schema.sql`](supabase/schema.sql).
4. From Project Settings/API collect:
   - Project URL
   - **service-role** key

The service-role key is intentionally used only on the Next.js server. The app does not expose Supabase credentials to the browser.

## 2. Local setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Set these values in `.env.local`:

```text
OPENAI_API_KEY=...
APP_PIN=...
SESSION_SECRET=...
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

Generate a strong session secret, for example:

```bash
openssl rand -hex 32
```

## 3. Optional authenticated YouTube access

Public/unlisted videos do not require YouTube authentication.

For videos that are age-restricted, members-only, private, or otherwise login-required, set:

```text
YOUTUBE_COOKIE=SID=...; HSID=...; ...
```

Use the Cookie header from a YouTube/Google account that is already authorized to view the target video. Keep it only in Vercel environment variables. It will expire periodically and must then be replaced.

Important: no application can access a private/member video if the YouTube account represented by the cookie is not authorized to view it. YouTube can also block cloud-hosted extraction traffic or change undocumented interfaces; the app reports these failures rather than hiding them.

## 4. Deploy on Vercel

1. Push this folder to a GitHub repository.
2. In Vercel choose **Add New → Project** and import that repository.
3. Add all required variables from `.env.example` under **Project Settings → Environment Variables**.
4. Enable **Fluid Compute** for the project if it is not already enabled.
5. Deploy.

The heavy API routes specify a 300-second maximum duration, matching the current Vercel Hobby Fluid Compute ceiling.

## Storage behavior

`supabase/schema.sql` creates a daily Supabase Cron job that:

- sets transcripts older than 90 days to `NULL`;
- leaves summaries untouched;
- removes abandoned temporary transcript chunks older than one day.

Supabase Free currently provides a 500 MB database. For personal use this should be adequate for a substantial summary library, but raw transcripts are deliberately expired because they are the largest persistent objects.

## Long videos

Captioned videos are cheap and efficient because only text is processed.

No-caption videos are split into 8-minute audio windows. Each window is handled by a separate Vercel request and transcribed independently, which prevents one very long video from requiring a single multi-hour server process. The UI processes those windows sequentially and shows progress.

A chunk can still fail because of YouTube throttling, authentication, network conditions, Vercel execution limits, or OpenAI/API errors. The app returns a specific error in the queue instead of freezing.

## Models

Models are environment-configurable:

```text
OPENAI_SUMMARY_MODEL=gpt-5-mini
OPENAI_CLASSIFIER_MODEL=gpt-5-nano
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
```

No code change is needed if you want to swap to another compatible OpenAI model later.

## Security notes

- Never commit `.env.local`.
- Never expose `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `APP_PIN`, `SESSION_SECRET`, or `YOUTUBE_COOKIE` in client code.
- Use a long, non-obvious PIN/password even though the UI calls it a PIN.
- The session cookie is HTTP-only, SameSite=Lax, and Secure in production.
- RLS is enabled on both Supabase tables with no public policies; server service-role access is used instead.

## Current intentional limitations

- Version 1 accepts YouTube URLs only, but extraction is isolated in `lib/youtube.ts` so additional sources can be added later.
- Playlist extraction is capped at 500 videos per submitted playlist to prevent accidental huge jobs.
- No thumbnails are stored or displayed.
- No transcript UI is exposed.
- No external fact checking is performed.
