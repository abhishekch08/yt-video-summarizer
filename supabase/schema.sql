-- Run this once in Supabase SQL Editor.
-- The web app uses the service-role/secret key server-side only. No browser database key is used.

create extension if not exists pgcrypto;
create extension if not exists pg_cron;

create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'youtube',
  source_video_id text not null,
  url text not null,
  title text not null,
  channel_name text,
  duration_seconds integer,
  video_type text check (video_type is null or video_type in ('technical','finance','tutorial','interview','news','education','general')),
  transcript text,
  transcript_source text check (transcript_source is null or transcript_source in ('captions','audio')),
  transcript_expires_at timestamptz,
  summary_concise text,
  summary_standard text,
  summary_detailed text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source, source_video_id)
);

create table if not exists public.transcript_chunks (
  video_id uuid not null references public.videos(id) on delete cascade,
  chunk_index integer not null,
  text text not null,
  updated_at timestamptz not null default now(),
  primary key(video_id, chunk_index)
);

create index if not exists videos_updated_at_idx on public.videos(updated_at desc);
create index if not exists videos_created_at_idx on public.videos(created_at desc);
create index if not exists videos_type_idx on public.videos(video_type);
create index if not exists videos_transcript_expiry_idx on public.videos(transcript_expires_at);

alter table public.videos enable row level security;
alter table public.transcript_chunks enable row level security;
-- Deliberately no anon/authenticated policies. Only the server-side service role can access these rows.

-- Tables created through raw SQL are not necessarily granted to Data API roles automatically.
-- The backend uses Supabase's secret/service-role key, so grant only service_role here.
grant select, insert, update, delete on table public.videos to service_role;
grant select, insert, update, delete on table public.transcript_chunks to service_role;

create or replace function public.cleanup_expired_video_transcripts()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.videos
  set transcript = null,
      transcript_source = null,
      transcript_expires_at = null,
      updated_at = now()
  where transcript is not null
    and transcript_expires_at is not null
    and transcript_expires_at < now();

  delete from public.transcript_chunks
  where updated_at < now() - interval '1 day';
end;
$$;

-- Idempotent cron setup: remove the old job with this name if it exists, then recreate it.
do $$
declare
  existing_job bigint;
begin
  select jobid into existing_job from cron.job where jobname = 'cleanup-video-transcripts-90d' limit 1;
  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;
end $$;

select cron.schedule(
  'cleanup-video-transcripts-90d',
  '17 3 * * *',
  $$select public.cleanup_expired_video_transcripts();$$
);
