/**
 * World-context provider for the demo. Fills the `# Current context` prompt
 * section every turn with:
 *   1. Today's date + timezone (always).
 *   2. Top few web-search snippets on whatever the person just said,
 *      when the utterance carries enough signal to be worth searching.
 *
 * Why: LLMs are pinned to their training cutoff, so without live grounding
 * they'll insist "the world cup hasnt happened yet" mid-2026 or debate F1
 * as if the season paused in 2023. This provider just does a basic web
 * search — no API key, no billing, no plugin.
 *
 * Search backend: DuckDuckGo's HTML endpoint (html.duckduckgo.com). It's a
 * plain HTTP GET on a search page; we scrape the top 3 results. No account,
 * no key. If DDG rate-limits us or the page markup changes, `ddgSearch`
 * returns empty and the provider gracefully degrades to just the date line.
 *
 * Caching: 10-min TTL per query so a conversation that stays on the same
 * topic doesn't hit the network every turn. Very short utterances ("yeah",
 * "hm") are skipped — no signal to search on.
 */

import type { WorldContextProvider } from '@humanoid/humanoid';

const CACHE_TTL_MS = 10 * 60 * 1000;
const MIN_QUERY_LEN = 15;
const SEARCH_TIMEOUT_MS = 5000;
const RESULT_COUNT = 3;

const searchCache = new Map<string, { at: number; text: string }>();

/** Long-form English date + time-of-day + IANA tz. Fresh every call. */
function formatToday(): string {
  const now = new Date();
  const date = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const time = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `Today is ${date}, ${time} (${tz}).`;
}

/** Strip HTML tags and decode the handful of entities DDG actually emits. */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Hit DuckDuckGo's HTML search endpoint and extract the top result titles +
 * snippets. Cached by query string; returns empty string on any failure so
 * the caller can gracefully drop the search-results block.
 */
async function ddgSearch(query: string): Promise<string> {
  const q = query.trim();
  if (q.length < MIN_QUERY_LEN) return '';

  const cached = searchCache.get(q);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.text;

  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; humanoid-agent-demo/0.1; +https://github.com/ethan-dev-academia/humanoid-agent-demo)',
      },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!resp.ok) return '';
    const html = await resp.text();

    // Match each result block: title link followed (within the same block)
    // by the snippet link. Non-greedy, tolerant of attribute reordering.
    const titles: string[] = [];
    const snippets: string[] = [];
    const titleRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = titleRe.exec(html)) !== null && titles.length < RESULT_COUNT) {
      const t = m[1];
      if (t) titles.push(stripHtml(t));
    }
    while ((m = snippetRe.exec(html)) !== null && snippets.length < RESULT_COUNT) {
      const s = m[1];
      if (s) snippets.push(stripHtml(s));
    }

    const lines: string[] = [];
    const n = Math.min(titles.length, snippets.length);
    for (let i = 0; i < n; i++) {
      const t = titles[i];
      const s = snippets[i];
      if (t && s) lines.push(`- ${t}: ${s}`);
    }
    const text = lines.join('\n');
    searchCache.set(q, { at: Date.now(), text });
    return text;
  } catch {
    return '';
  }
}

/**
 * Provider entry point. Always includes today's date; adds a small
 * web-search snippet block when the current utterance is substantive
 * enough to search on. Failures silently degrade to date-only.
 */
export const worldContext: WorldContextProvider = async (req) => {
  const dateLine = formatToday();
  const q = req.currentUtterance.trim();
  const searchResults = await ddgSearch(q);
  if (!searchResults) return dateLine;
  const queryPreview = q.length > 60 ? q.slice(0, 57) + '…' : q;
  return `${dateLine}\n\nWeb search on "${queryPreview}":\n${searchResults}`;
};
