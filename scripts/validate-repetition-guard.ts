/**
 * Repetition-guard regression harness. Two-agent conversation with a mock
 * LLM that DELIBERATELY tries to repeat itself; asserts the SDK's
 * anti-repetition and dedup guards break the loop.
 *
 * Assertions:
 * 1. No exact reply text appears more than 3 times in the last 20 turns.
 * 2. At least 8 distinct reply texts in any rolling window of 15 turns.
 * 3. When the SDK's anti-repetition nudge triggers, the `('generation',
 *    'prompt', ...)` event's payload should include repetitionMitigated=true.
 *
 * Exit code 0 on pass, 1 on any assertion violation.
 *
 * Usage: pnpm validate:repetition
 */

import 'dotenv/config';

import type { JournalEvent, JournalSink } from '@humanoid/journal';
import type { PersonId } from '@humanoid/types';
import { Agent } from '@humanoid/humanoid';
import { InMemoryStore } from '@humanoid/ground-store';

import { character as ariaCharacter } from '../src/character.js';
import { XENOVA_EMBEDDING_DIM, createXenovaEmbed } from '../src/providers.js';

const TURNS = 40;
const PEER = 'test-peer' as PersonId;

let mockTurnCount = 0;
async function mockGenerate(prompt: string): Promise<string> {
  mockTurnCount++;
  if (mockTurnCount <= 10) return 'hm.';
  const responses = [
    'yeah',
    'hm.',
    'yeah exactly',
    'hm.',
    'true',
  ];
  return responses[mockTurnCount % responses.length];
}

class CapturingSink implements JournalSink {
  readonly events: JournalEvent[] = [];
  async record(event: JournalEvent): Promise<void> { this.events.push(event); }
  async recordBatch(events: readonly JournalEvent[]): Promise<void> {
    for (const e of events) this.events.push(e);
  }
}

interface Violation { readonly assertion: string; readonly detail: string; }

async function main(): Promise<void> {
  console.error('[loading local embedding model — first run downloads ~30MB]');
  const embed = await createXenovaEmbed();
  console.error('[embedding model ready]');

  const store = new InMemoryStore();
  const sink = new CapturingSink();
  const agent = new Agent({
    store, character: ariaCharacter, embeddingDim: XENOVA_EMBEDDING_DIM,
    models: { generation: { generate: mockGenerate, embed } },
    journalSink: sink,
  });

  const replies: string[] = [];
  let input = 'hey how are you doing';
  for (let turn = 1; turn <= TURNS; turn++) {
    try {
      const result = await agent.turn(PEER, `${input} (t${turn})`);
      const reply = result.messages.map((m) => m.text).join('\n\n');
      replies.push(reply);
      input = reply;
      if (turn % 10 === 0) {
        console.error(`  [turn ${turn}] last-reply="${reply.slice(0, 40)}"`);
      }
    } catch (err) {
      console.error(`  [turn ${turn} error]`, err);
      break;
    }
  }

  const violations: Violation[] = [];

  const lastTwenty = replies.slice(-20);
  const counts = new Map<string, number>();
  for (const r of lastTwenty) counts.set(r, (counts.get(r) ?? 0) + 1);
  for (const [text, n] of counts) {
    if (n > 3) {
      violations.push({
        assertion: 'no reply repeated > 3 times in last 20 turns',
        detail: `"${text.slice(0, 40)}" appeared ${n} times`,
      });
    }
  }

  for (let start = 0; start + 15 <= replies.length; start++) {
    const window = replies.slice(start, start + 15);
    const distinct = new Set(window).size;
    if (distinct < 8) {
      violations.push({
        assertion: 'window of 15 turns has >= 8 distinct replies',
        detail: `turns ${start + 1}-${start + 15}: only ${distinct} distinct`,
      });
      break;
    }
  }

  const promptEvents = sink.events.filter((e) => e.module === 'generation' && e.type === 'prompt');
  const highRatioEvents = promptEvents.filter((e) => {
    const p = e.payload as { repetitionRatio?: number };
    return (p.repetitionRatio ?? 0) >= 0.5;
  });
  const mitigatedEvents = highRatioEvents.filter((e) => {
    const p = e.payload as { repetitionMitigated?: boolean };
    return p.repetitionMitigated === true;
  });
  if (highRatioEvents.length > 0 && mitigatedEvents.length === 0) {
    violations.push({
      assertion: 'anti-repetition nudge triggers when ratio >= 0.5',
      detail: `${highRatioEvents.length} high-ratio prompts, but 0 marked mitigated`,
    });
  }

  const dedupEvents = sink.events.filter((e) => e.module === 'memory-retrieval' && e.type === 'dedup');
  const uniqueReplies = new Set(replies).size;

  console.error('');
  console.error('=== REPETITION-GUARD SUMMARY ===');
  console.error(`turns:              ${replies.length}/${TURNS}`);
  console.error(`unique replies:     ${uniqueReplies}`);
  console.error(`prompt events:      ${promptEvents.length}`);
  console.error(`high-ratio prompts: ${highRatioEvents.length}`);
  console.error(`mitigated:          ${mitigatedEvents.length}`);
  console.error(`retrieval dedups:   ${dedupEvents.length}`);

  if (violations.length === 0) {
    console.error('\nPASS: repetition guard broke the mock LLM out of the loop.');
    process.exit(0);
  }

  console.error(`\nFAIL: ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error(`  - ${v.assertion}  |  ${v.detail}`);
  }
  process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
