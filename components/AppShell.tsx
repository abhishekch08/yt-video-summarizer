'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Check, ChevronDown, Clipboard, Download, History,
  LoaderCircle, LogOut, Menu, MessageSquare, Plus, RefreshCcw, Search,
  Send, Sparkles, Trash2, X
} from 'lucide-react';
import type { SummaryDepth, VideoRecord, VideoType } from '@/types/app';

type LocalQueueItem = {
  url: string;
  status: 'queued' | 'working' | 'done' | 'error';
  stage: string;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  videoId?: string;
  title?: string;
};

type ChatTurn = { question: string; answer: string; loading?: boolean };

const DEPTHS: SummaryDepth[] = ['concise', 'standard', 'detailed'];
const VIDEO_TYPES: Array<'all' | VideoType> = ['all', 'technical', 'finance', 'tutorial', 'interview', 'news', 'education', 'general'];

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

async function readSse(res: Response, onEvent: (event: any) => void) {
  if (!res.body) throw new Error('Streaming response was unavailable.');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
      if (!dataLine) continue;
      try { onEvent(JSON.parse(dataLine.slice(6))); } catch {}
    }
  }
}

function summaryOf(video: VideoRecord | null, depth: SummaryDepth) {
  if (!video) return '';
  if (depth === 'concise') return video.summary_concise || '';
  if (depth === 'detailed') return video.summary_detailed || '';
  return video.summary_standard || '';
}

function formatDuration(seconds: number | null) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function formatElapsed(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

function plainText(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*/g, '').replace(/```/g, ''))
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[-*+]\s+/gm, '• ')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
}

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      await jsonFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ pin }) });
      onSuccess();
    } catch (e) { setError(e instanceof Error ? e.message : 'Login failed'); }
    finally { setBusy(false); }
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="brand-mark"><Sparkles size={20} /></div>
        <h1>Video Summary</h1>
        <p>Enter your private PIN.</p>
        <input
          autoFocus type="password" inputMode="text" autoComplete="current-password"
          value={pin} onChange={(e) => setPin(e.target.value)} placeholder="PIN" aria-label="PIN"
        />
        {error && <div className="form-error">{error}</div>}
        <button className="primary-button" disabled={busy || !pin}>
          {busy ? <LoaderCircle className="spin" size={17} /> : 'Continue'}
        </button>
      </form>
    </main>
  );
}

export default function AppShell({ initialAuthenticated }: { initialAuthenticated: boolean }) {
  const [authenticated, setAuthenticated] = useState(initialAuthenticated);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [history, setHistory] = useState<VideoRecord[]>([]);
  const [selected, setSelected] = useState<VideoRecord | null>(null);
  const [depth, setDepth] = useState<SummaryDepth>('standard');
  const [liveSummary, setLiveSummary] = useState('');
  const [summaryStage, setSummaryStage] = useState('');
  const [queue, setQueue] = useState<LocalQueueItem[]>([]);
  const [queueRunning, setQueueRunning] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | VideoType>('all');
  const [dateFilter, setDateFilter] = useState('all');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [qaOpen, setQaOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [chat, setChat] = useState<ChatTurn[]>([]);
  const [qaBusy, setQaBusy] = useState(false);
  const [toast, setToast] = useState('');
  const currentQueueIndex = queue.findIndex((item) => item.status === 'working');
  const summaryRef = useRef('');

  useEffect(() => {
    if (!queue.some((x) => x.status === 'working')) return;
    const id = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(id);
  }, [queue]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 2200);
    return () => clearTimeout(id);
  }, [toast]);

  const loadHistory = useCallback(async () => {
    if (!authenticated) return;
    setHistoryLoading(true);
    try {
      const p = new URLSearchParams();
      if (search.trim()) p.set('q', search.trim());
      if (typeFilter !== 'all') p.set('type', typeFilter);
      if (dateFilter !== 'all') p.set('date', dateFilter);
      const data = await jsonFetch<{ videos: VideoRecord[] }>(`/api/videos?${p.toString()}`);
      setHistory(data.videos);
    } catch {}
    finally { setHistoryLoading(false); }
  }, [authenticated, search, typeFilter, dateFilter]);

  useEffect(() => {
    const id = setTimeout(loadHistory, 250);
    return () => clearTimeout(id);
  }, [loadHistory]);

  async function openVideo(id: string) {
    const data = await jsonFetch<{ video: VideoRecord }>(`/api/videos/${id}`);
    setSelected(data.video);
    const firstDepth = data.video.summary_standard ? 'standard' : data.video.summary_concise ? 'concise' : data.video.summary_detailed ? 'detailed' : 'standard';
    setDepth(firstDepth);
    setLiveSummary('');
    setSummaryStage('');
    setChat([]);
    setQaOpen(false);
    setSidebarOpen(false);
  }

  function updateQueue(index: number, patch: Partial<LocalQueueItem>) {
    setQueue((prev) => prev.map((item, i) => i === index ? { ...item, ...patch } : item));
  }

  async function ensureTranscript(url: string, videoIdHint?: string, queueIndex?: number, forceRefresh = false) {
    const prepared = await jsonFetch<any>('/api/videos/prepare', {
      method: 'POST', body: JSON.stringify({ url, forceRefresh }),
    });
    const id = prepared.videoId || videoIdHint;
    if (!id) throw new Error('Video ID was not returned.');

    if (prepared.status === 'needs_transcription') {
      for (let i = 0; i < prepared.totalChunks; i++) {
        const stage = `Transcribing audio ${i + 1}/${prepared.totalChunks}`;
        setSummaryStage(stage);
        if (queueIndex !== undefined) updateQueue(queueIndex, { stage });
        await jsonFetch(`/api/videos/${id}/transcribe-chunk`, {
          method: 'POST', body: JSON.stringify({ index: i, chunkSeconds: prepared.chunkSeconds }),
        });
      }
      setSummaryStage('Finalizing transcript');
      if (queueIndex !== undefined) updateQueue(queueIndex, { stage: 'Finalizing transcript' });
      await jsonFetch(`/api/videos/${id}/transcribe-finalize`, { method: 'POST', body: '{}' });
    }
    return { videoId: id, title: prepared.title as string };
  }

  async function streamSummary(videoId: string, wantedDepth: SummaryDepth, onStage?: (stage: string) => void) {
    setLiveSummary(''); summaryRef.current = '';
    const res = await fetch(`/api/videos/${videoId}/summarize`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ depth: wantedDepth }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const error = new Error(err.error || `Summary failed (${res.status})`) as Error & { needsRefresh?: boolean };
      error.needsRefresh = err.needsRefresh;
      throw error;
    }
    await readSse(res, (event) => {
      if (event.type === 'stage') { setSummaryStage(event.message); onStage?.(event.message); }
      if (event.type === 'delta') {
        summaryRef.current += event.text;
        setLiveSummary(summaryRef.current);
      }
      if (event.type === 'error') throw new Error(event.message);
    });
    setSummaryStage('');
    await openVideo(videoId);
    await loadHistory();
  }

  async function processUrls() {
    const urls = [...urlInput.matchAll(/https?:\/\/[^\s,]+/g)].map((m) => m[0]);
    if (!urls.length || queueRunning) return;
    setQueueRunning(true);
    setLiveSummary(''); setSelected(null); setSummaryStage('Expanding URLs');
    try {
      const expanded = await jsonFetch<{ urls: string[] }>('/api/queue/expand', {
        method: 'POST', body: JSON.stringify({ urls }),
      });
      if (!expanded.urls.length) throw new Error('No YouTube videos were found.');
      setQueue(expanded.urls.map((url) => ({ url, status: 'queued', stage: 'Queued' })));
      setUrlInput('');

      for (let i = 0; i < expanded.urls.length; i++) {
        updateQueue(i, { status: 'working', stage: 'Fetching subtitles', startedAt: Date.now() });
        try {
          const prepared = await ensureTranscript(expanded.urls[i], undefined, i, false);
          updateQueue(i, { videoId: prepared.videoId, title: prepared.title, stage: 'Summarizing' });
          setSummaryStage('Summarizing');
          await openVideo(prepared.videoId);
          await streamSummary(prepared.videoId, 'standard', (stage) => updateQueue(i, { stage }));
          updateQueue(i, { status: 'done', stage: 'Done', finishedAt: Date.now() });
        } catch (e) {
          updateQueue(i, { status: 'error', stage: 'Failed', error: e instanceof Error ? e.message : 'Processing failed', finishedAt: Date.now() });
        }
      }
      await loadHistory();
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Could not start processing');
    } finally {
      setQueueRunning(false); setSummaryStage('');
    }
  }

  async function chooseDepth(next: SummaryDepth) {
    setDepth(next);
    if (!selected || summaryOf(selected, next)) { setLiveSummary(''); return; }
    try {
      await streamSummary(selected.id, next);
    } catch (e: any) {
      if (e.needsRefresh) {
        await ensureTranscript(selected.url, selected.id, undefined, true);
        await streamSummary(selected.id, next);
      } else setToast(e.message || 'Could not generate summary');
    }
  }

  async function regenerate() {
    if (!selected) return;
    try { await streamSummary(selected.id, depth); }
    catch (e: any) {
      if (e.needsRefresh) {
        await ensureTranscript(selected.url, selected.id, undefined, true);
        await streamSummary(selected.id, depth);
      } else setToast(e.message || 'Regeneration failed');
    }
  }

  async function askQuestion() {
    if (!selected || !question.trim() || qaBusy) return;
    const q = question.trim(); setQuestion(''); setQaBusy(true);
    setChat((prev) => [...prev, { question: q, answer: '', loading: true }]);

    async function runAsk() {
      const res = await fetch(`/api/videos/${selected!.id}/ask`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q }),
      });
      if (res.status === 409) {
        await ensureTranscript(selected!.url, selected!.id, undefined, true);
        return runAsk();
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Question failed');
      }
      let answer = '';
      await readSse(res, (event) => {
        if (event.type === 'delta') {
          answer += event.text;
          setChat((prev) => prev.map((turn, i) => i === prev.length - 1 ? { ...turn, answer } : turn));
        }
        if (event.type === 'error') throw new Error(event.message);
      });
      setChat((prev) => prev.map((turn, i) => i === prev.length - 1 ? { ...turn, loading: false } : turn));
    }

    try { await runAsk(); }
    catch (e) {
      const message = e instanceof Error ? e.message : 'Question failed';
      setChat((prev) => prev.map((turn, i) => i === prev.length - 1 ? { ...turn, answer: message, loading: false } : turn));
    } finally { setQaBusy(false); }
  }

  async function deleteSelected() {
    if (!selected || !window.confirm(`Delete “${selected.title}” and its stored summaries?`)) return;
    await jsonFetch(`/api/videos/${selected.id}`, { method: 'DELETE' });
    setSelected(null); setLiveSummary(''); await loadHistory(); setToast('Deleted');
  }

  async function logout() {
    await jsonFetch('/api/auth/logout', { method: 'POST', body: '{}' });
    setAuthenticated(false); setHistory([]); setSelected(null);
  }

  function copySummary() {
    const text = liveSummary || summaryOf(selected, depth);
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => setToast('Copied'));
  }

  function downloadSummary(ext: 'md' | 'txt') {
    if (!selected) return;
    const markdown = liveSummary || summaryOf(selected, depth);
    if (!markdown) return;
    const content = ext === 'txt' ? plainText(markdown) : markdown;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${selected.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) || 'summary'}-${depth}.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const shownSummary = liveSummary || summaryOf(selected, depth);
  const activeItem = currentQueueIndex >= 0 ? queue[currentQueueIndex] : null;
  const activeElapsed = activeItem?.startedAt ? Math.floor((clock - activeItem.startedAt) / 1000) : 0;

  if (!authenticated) return <Login onSuccess={() => setAuthenticated(true)} />;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-top">
          <button className="new-button" onClick={() => { setSelected(null); setLiveSummary(''); setSidebarOpen(false); }}>
            <Plus size={17} /> New summary
          </button>
          <button className="icon-button mobile-close" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar"><X size={19} /></button>
        </div>

        <div className="history-head"><History size={15} /><span>History</span>{historyLoading && <LoaderCircle className="spin" size={14} />}</div>
        <div className="history-controls">
          <label className="search-box"><Search size={15} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search titles" /></label>
          <div className="filter-row">
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as any)} aria-label="Video type">
              {VIDEO_TYPES.map((t) => <option key={t} value={t}>{t === 'all' ? 'All types' : t}</option>)}
            </select>
            <select value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} aria-label="Date filter">
              <option value="all">All time</option><option value="7d">7 days</option><option value="30d">30 days</option><option value="90d">90 days</option>
            </select>
          </div>
        </div>
        <div className="history-list">
          {history.map((video) => (
            <button key={video.id} className={`history-item ${selected?.id === video.id ? 'active' : ''}`} onClick={() => openVideo(video.id)}>
              <span className="history-title">{video.title}</span>
              <span className="history-meta">{video.video_type || 'unclassified'} · {new Date(video.updated_at).toLocaleDateString()}</span>
            </button>
          ))}
          {!historyLoading && history.length === 0 && <div className="empty-history">No saved summaries.</div>}
        </div>
        <button className="logout-button" onClick={logout}><LogOut size={16} /> Log out</button>
      </aside>
      {sidebarOpen && <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />}

      <main className="main-pane">
        <header className="mobile-header">
          <button className="icon-button" onClick={() => setSidebarOpen(true)} aria-label="Open menu"><Menu size={20} /></button>
          <span>Video Summary</span>
          <div className="header-spacer" />
        </header>

        {!selected && !liveSummary ? (
          <section className="new-view">
            <div className="hero">
              <div className="brand-mark small"><Sparkles size={18} /></div>
              <h1>Summarize a YouTube video</h1>
              <p>Paste one or more video or playlist URLs. Videos are processed one at a time.</p>
            </div>
            <div className="composer">
              <textarea
                value={urlInput} onChange={(e) => setUrlInput(e.target.value)}
                placeholder={'https://www.youtube.com/watch?v=...\nhttps://www.youtube.com/playlist?list=...'}
                rows={4} disabled={queueRunning}
              />
              <button className="send-button" onClick={processUrls} disabled={queueRunning || !urlInput.trim()} aria-label="Summarize">
                {queueRunning ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}
              </button>
            </div>
            {queue.length > 0 && (
              <div className="queue-card">
                <div className="queue-card-head">
                  <div><strong>Processing</strong><span>{queue.filter((x) => x.status === 'done').length}/{queue.length} complete</span></div>
                  {activeItem && <span className="elapsed">{formatElapsed(activeElapsed)}</span>}
                </div>
                <div className="queue-list">
                  {queue.map((item, i) => (
                    <div className={`queue-row ${item.status}`} key={`${item.url}-${i}`}>
                      <div className={`queue-status ${item.status}`}>
                        {item.status === 'working' ? <LoaderCircle className="spin" size={15} /> : item.status === 'done' ? <Check size={15} /> : item.status === 'error' ? <X size={15} /> : <span>{i + 1}</span>}
                      </div>
                      <div className="queue-copy">
                        <span>{item.title || item.url}</span>
                        <small>{item.stage}{item.status === 'working' ? ` · Queue ${i + 1}/${queue.length}` : ''}{item.error ? ` · ${item.error}` : ''}</small>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        ) : (
          <section className="summary-view">
            <div className="summary-topbar">
              <div className="video-heading">
                <h1>{selected?.title || 'Generating summary…'}</h1>
                {selected && <p>{[selected.channel_name, formatDuration(selected.duration_seconds), selected.video_type].filter(Boolean).join(' · ')}</p>}
              </div>
              <div className="summary-actions">
                <button className="icon-button" onClick={copySummary} title="Copy summary"><Clipboard size={17} /></button>
                <div className="download-menu">
                  <button className="icon-button" title="Download"><Download size={17} /></button>
                  <div className="download-pop"><button onClick={() => downloadSummary('md')}>Markdown (.md)</button><button onClick={() => downloadSummary('txt')}>Text (.txt)</button></div>
                </div>
                <button className="icon-button danger-hover" onClick={deleteSelected} title="Delete"><Trash2 size={17} /></button>
              </div>
            </div>

            <div className="depth-bar">
              <div className="depth-tabs">
                {DEPTHS.map((d) => <button key={d} onClick={() => chooseDepth(d)} className={depth === d ? 'active' : ''}>{d[0].toUpperCase() + d.slice(1)}</button>)}
              </div>
              <button className="regenerate-button" onClick={regenerate} disabled={!selected || !!summaryStage}><RefreshCcw size={14} /> Regenerate</button>
            </div>

            {summaryStage && <div className="stage-banner"><LoaderCircle className="spin" size={15} /><span>{summaryStage}</span></div>}
            <article className="markdown-body">
              {shownSummary ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{shownSummary}</ReactMarkdown> : <div className="summary-skeleton"><div /><div /><div /><div /></div>}
            </article>

            {selected && (
              <div className="qa-section">
                <button className="qa-toggle" onClick={() => setQaOpen((v) => !v)}>
                  <MessageSquare size={16} /><span>Ask about this video</span><ChevronDown size={15} className={qaOpen ? 'rotated' : ''} />
                </button>
                {qaOpen && (
                  <div className="qa-panel">
                    {chat.map((turn, i) => (
                      <div className="qa-turn" key={i}>
                        <div className="qa-question">{turn.question}</div>
                        <div className="qa-answer"><ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.answer || ' '}</ReactMarkdown>{turn.loading && <span className="typing-dot">●</span>}</div>
                      </div>
                    ))}
                    <div className="qa-composer">
                      <input value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') askQuestion(); }} placeholder="Ask a question about the video…" />
                      <button onClick={askQuestion} disabled={qaBusy || !question.trim()}>{qaBusy ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        )}
      </main>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
