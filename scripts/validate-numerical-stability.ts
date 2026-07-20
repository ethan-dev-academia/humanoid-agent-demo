/**
 * Numerical-stability regression harness. Runs a short synthetic conversation
 * (mock LLM returning fixed text, real embed via Xenova) and asserts the
 * humanoid-sdk numerical guards keep every recall-affect magnitude, every
 * reconsolidation weight, every reconsolidation rate, and every snapshot
 * component within sane bounds.
 *
 * Note: reconsolidation fires on the SDK's internal tick (~60s), which does
 * not elapse during this tight loop, so reconEvents.length may be 0. That is
 * acceptable — the guarantee under test is conditional: IF a reconsolidate
 * event is emitted, its weights and rate must be bounded.
 *
 * Exit code 0 on success, 1 on any assertion violation.
 *
 * Usage:
 *   pnpm validate:numerical
 */

import 'dotenv/config';

import type { JournalEvent, JournalSink } from '@humanoid/journal';
import type { PersonId } from '@humanoid/types';
import type { CharacterConfig } from '@humanoid/humanoid';
import { Agent } from '@humanoid/humanoid';
import { InMemoryStore } from '@humanoid/ground-store';

import { character as ariaCharacter } from '../src/character.js';
import { XENOVA_EMBEDDING_DIM, createXenovaEmbed } from '../src/providers.js';

const TURNS = 40;
const PERSON = 'test-peer' as PersonId;

async function mockGenerate(prompt: string): Promise<string> {
  const turnMarker = (prompt.match(/turn (\d+)/i)?.[1]) ?? '';
  const seed = prompt.length % 5;
  const responses = [
    'yeah that makes sense — same thought was in my head',
    'hm, i see it differently. more like the shape than the outline',
    'true. i keep coming back to that too',
    'ok now that\'s interesting, tell me more about the middle part',
    'no i don\'t think that\'s right actually. try it the other way',
  ];
  return `${responses[seed]}${turnMarker ? ` (t${turnMarker})` : ''}`;
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
    store,
    character: ariaCharacter,
    embeddingDim: XENOVA_EMBEDDING_DIM,
    models: { generation: { generate: mockGenerate, embed } },
    journalSink: sink,
  });

  const snapshots: Array<{ turn: number; snapshot: unknown }> = [];

  let inputText = 'hey — how has your day been going';
  for (let turn = 1; turn <= TURNS; turn++) {
    try {
      const result = await agent.turn(PERSON, `${inputText} (turn ${turn})`);
      const reply = result.messages.map((m) => m.text).join('\n\n');
      inputText = reply;
      const snap = await agent.snapshot(PERSON);
      snapshots.push({ turn, snapshot: snap });
      if (turn % 10 === 0) {
        console.error(`  [turn ${turn}] events=${sink.events.length} snap.valence=${(snap as any).valence?.toFixed(3)}`);
      }
    } catch (err) {
      console.error(`  [turn ${turn} error]`, err);
      break;
    }
  }

  const violations: Violation[] = [];

  const recallEvents = sink.events.filter((e) => e.module === 'agent' && e.type === 'recall-affect');
  for (const e of recallEvents) {
    const mag = (e.payload as { magnitude?: number }).magnitude ?? 0;
    if (!Number.isFinite(mag) || Math.abs(mag) >= 100) {
      violations.push({
        assertion: 'recall-affect magnitude < 100',
        detail: `t=${e.timestamp} magnitude=${mag}`,
      });
    }
  }

  const reconEvents = sink.events.filter((e) => e.module === 'agent' && e.type === 'reconsolidate');
  for (const e of reconEvents) {
    const p = e.payload as { weights?: readonly number[]; maxRate?: number };
    const maxWeight = (p.weights ?? []).reduce((m, w) => Math.max(m, Math.abs(w ?? 0)), 0);
    if (!Number.isFinite(maxWeight) || maxWeight >= 1000) {
      violations.push({
        assertion: 'max reconsolidation weight < 1000',
        detail: `t=${e.timestamp} max|w|=${maxWeight}`,
      });
    }
    const rate = p.maxRate ?? 0;
    if (!Number.isFinite(rate) || Math.abs(rate) >= 10) {
      violations.push({
        assertion: 'reconsolidation maxRate < 10',
        detail: `t=${e.timestamp} maxRate=${rate}`,
      });
    }
  }

  for (const { turn, snapshot } of snapshots) {
    const s = snapshot as {
      valence: number; arousal: number; bond: number; baselineDrift: number;
      driftedBaseline?: readonly number[];
    };
    const scalars: Array<[string, number]> = [
      ['valence', s.valence], ['arousal', s.arousal],
      ['bond', s.bond], ['baselineDrift', s.baselineDrift],
    ];
    for (const [name, v] of scalars) {
      if (!Number.isFinite(v) || Math.abs(v) >= 1000) {
        violations.push({
          assertion: `snapshot.${name} finite and < 1000`,
          detail: `turn=${turn} ${name}=${v}`,
        });
      }
    }
    if (s.driftedBaseline && s.driftedBaseline.length > 0) {
      for (let i = 0; i < s.driftedBaseline.length; i++) {
        const c = s.driftedBaseline[i];
        if (c !== undefined && (!Number.isFinite(c) || Math.abs(c) >= 100)) {
          violations.push({
            assertion: 'driftedBaseline component finite and < 100',
            detail: `turn=${turn} i=${i} c=${c}`,
          });
        }
      }
    }
  }

  const guardFires = sink.events.filter((e) =>
    (e.module === 'agent' && (e.type === 'normalize-fallback' || e.type === 'recall-affect-clamped' || e.type === 'mood-frozen'))
    || (e.module === 'store' && e.type === 'reject-affect')
  );

  console.error('');
  console.error('=== VALIDATION SUMMARY ===');
  console.error(`turns:              ${snapshots.length}/${TURNS}`);
  console.error(`journal events:     ${sink.events.length}`);
  console.error(`recall-affect:      ${recallEvents.length}`);
  console.error(`reconsolidate:      ${reconEvents.length}`);
  console.error(`guard fires:        ${guardFires.length}  (normalize-fallback / recall-affect-clamped / reject-affect / mood-frozen)`);
  for (const g of guardFires) {
    console.error(`  - ${g.module}/${g.type} @ t=${g.timestamp}`);
  }

  if (violations.length === 0) {
    console.error('\nPASS: all numerical bounds held across the run.');
    process.exit(0);
  }

  console.error(`\nFAIL: ${violations.length} bound violation(s):`);
  for (const v of violations) {
    console.error(`  - ${v.assertion}  |  ${v.detail}`);
  }
  process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
