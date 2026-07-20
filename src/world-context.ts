/**
 * World-context provider for the demo. Fills the `# Current context` prompt
 * section that Aria and Milo see every turn — today's date + a small
 * editable blob of recent facts they can reference.
 *
 * Why this exists: LLMs are pinned to their training cutoff. Without a live
 * date and current world facts, they'll insist "spa hasn't happened yet"
 * mid-2025 or debate F1 as if the season paused in 2023. Injecting a fresh
 * context block on every turn cheaply fixes both problems.
 *
 * Extend by wiring a real data source below — a news API, an F1 results
 * fetcher, a Wikipedia recent-changes query, a web-search wrapper. The
 * interface just returns a string, so anything you can format into text
 * works. Async is fine; the Agent awaits per turn.
 */

import type { WorldContextProvider } from '@humanoid/humanoid';

/**
 * Manually-maintained blob of current-world facts. Edit before a sim run
 * when you want the agents debating something with fresh context. Keep it
 * short — this is prepended to every prompt.
 */
const CURRENT_WORLD_NOTES = `
F1 season status (edit before a sim run if you want fresh context here):
- Update this bullet with the latest race result before running the sim
- Second bullet — championship standings, driver switches, injuries
- Third bullet — anything else the personas would care about

Music / culture (edit as you please):
- Add a track / album / release both personas might reasonably know about
- Add a movie or show worth mentioning
`.trim();

/** Long-form English date + time-of-day + timezone offset. */
function formatToday(): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `Today is ${dateStr}, ${timeStr} (${tz}).`;
}

/**
 * Default provider for the demo — today's date + the manually-maintained
 * notes blob. Static generation of the notes; date is computed fresh each
 * call so a long-running sim sees the day roll over correctly.
 */
export const worldContext: WorldContextProvider = () => {
  const dateLine = formatToday();
  const notes = CURRENT_WORLD_NOTES;
  return `${dateLine}\n\n${notes}`;
};
