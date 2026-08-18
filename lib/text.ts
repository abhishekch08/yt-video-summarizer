export function decodeHtml(input: string) {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function normalizeCaptionPiece(s: string) {
  return decodeHtml(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[(music|applause|laughter|silence|foreign|noise|cheering)\]/gi, ' ')
    .replace(/♪[^♪]*♪/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordOverlap(a: string, b: string, max = 14) {
  const aw = a.split(/\s+/);
  const bw = b.split(/\s+/);
  const limit = Math.min(max, aw.length, bw.length);
  for (let n = limit; n >= 2; n--) {
    const tail = aw.slice(-n).join(' ').toLowerCase();
    const head = bw.slice(0, n).join(' ').toLowerCase();
    if (tail === head) return n;
  }
  return 0;
}

export function cleanTranscript(parts: string[] | string) {
  const rawParts = Array.isArray(parts) ? parts : parts.split(/\n+/);
  const cleaned: string[] = [];

  for (const raw of rawParts) {
    let s = normalizeCaptionPiece(raw);
    if (!s) continue;
    if (/^\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?\s*-->/.test(s)) continue;

    const prev = cleaned.at(-1);
    if (!prev) {
      cleaned.push(s);
      continue;
    }

    if (s.toLowerCase() === prev.toLowerCase()) continue;
    if (s.toLowerCase().startsWith(prev.toLowerCase()) && s.length < prev.length * 2.5) {
      cleaned[cleaned.length - 1] = s;
      continue;
    }
    if (prev.toLowerCase().startsWith(s.toLowerCase())) continue;

    const overlap = wordOverlap(prev, s);
    if (overlap) s = s.split(/\s+/).slice(overlap).join(' ');
    if (s) cleaned.push(s);
  }

  return cleaned.join(' ').replace(/\s+([,.;!?])/g, '$1').replace(/\s+/g, ' ').trim();
}

export function chunkText(text: string, maxChars = 180_000) {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const candidate = text.lastIndexOf('. ', end);
      if (candidate > start + maxChars * 0.7) end = candidate + 1;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks.filter(Boolean);
}
