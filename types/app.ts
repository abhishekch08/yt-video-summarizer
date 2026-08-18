export type SummaryDepth = 'concise' | 'standard' | 'detailed';

export type VideoType =
  | 'technical'
  | 'finance'
  | 'tutorial'
  | 'interview'
  | 'news'
  | 'education'
  | 'general';

export interface VideoRecord {
  id: string;
  source: 'youtube';
  source_video_id: string;
  url: string;
  title: string;
  channel_name: string | null;
  duration_seconds: number | null;
  video_type: VideoType | null;
  transcript_source: 'captions' | 'audio' | null;
  transcript_expires_at: string | null;
  transcript_available?: boolean;
  summary_concise: string | null;
  summary_standard: string | null;
  summary_detailed: string | null;
  created_at: string;
  updated_at: string;
}

export interface QueueItem {
  url: string;
  status: 'queued' | 'working' | 'done' | 'error';
  stage: string;
  elapsedSeconds: number;
  error?: string;
  videoId?: string;
  title?: string;
}
