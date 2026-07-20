/**
 * Agent-to-agent conversation simulator. Two Agents (Aria + Milo) talk to
 * each other for N turns; each agent has its own dashboard on its own port
 * (7373 for Aria, 7374 for Milo — open both in a browser side-by-side to
 * watch mutual influence in real time). Full transcript, per-agent snapshot
 * timeline, and per-agent journal event stream are captured to
 * `sim-runs/<timestamp>.json` for post-hoc drift/convergence analysis.
 *
 * Tuned for long-horizon batches — a full run is 30–45 minutes so plasticity
 * (§12 Eq. 18), consolidation, belief-revision, and rumination all get enough
 * wall-clock time to move the drifted baseline visibly. A background tick
 * timer fires Algorithm 2 for both agents on `SIM_TICK_INTERVAL_MS` cadence
 * during the run — without this, no matter how many turns you queue, the
 * cognition tier stays dormant and you'd only see live-path affect noise.
 *
 * Configuration via env (or defaults):
 *   SIM_TURNS              — hard cap on turn count (default 500)
 *   SIM_DURATION_MS        — hard cap on wall-clock (default 2_400_000 = 40 min)
 *                            Whichever cap trips first ends the batch.
 *   SIM_TURN_DELAY_MS      — pause between turns (default 2000)
 *   SIM_TICK_INTERVAL_MS   — background Algorithm 2 cadence for BOTH agents
 *                            during the run (default 60000)
 *   SIM_SEED               — Aria's opening line (default "hey — how are you doing?")
 *   OPENROUTER_MODEL       — same as chat mode
 */

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { PersonId } from '@humanoid/types';
import type { AgentSnapshot, CharacterConfig } from '@humanoid/humanoid';
import type { JournalEvent, JournalSink } from '@humanoid/journal';
import { Agent } from '@humanoid/humanoid';
import { InMemoryStore } from '@humanoid/ground-store';

import { character as ariaCharacter } from './character.js';
import { character as miloCharacter } from './character-milo.js';
import { XENOVA_EMBEDDING_DIM, createOpenRouterChat, createXenovaEmbed } from './providers.js';
import { createVizServer, type VizServerHandle } from './viz/server.js';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-4.6';
const SIM_TURNS = Number.parseInt(process.env.SIM_TURNS ?? '500', 10);
const SIM_DURATION_MS = Number.parseInt(process.env.SIM_DURATION_MS ?? '2400000', 10);
const SIM_TURN_DELAY_MS = Number.parseInt(process.env.SIM_TURN_DELAY_MS ?? '2000', 10);
const SIM_TICK_INTERVAL_MS = Number.parseInt(process.env.SIM_TICK_INTERVAL_MS ?? '60000', 10);
const SIM_SEED = process.env.SIM_SEED ?? 'hey — how are you doing?';

if (!OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY is missing.');
  console.error('Copy .env.example → .env and paste your key from https://openrouter.ai/keys.');
  process.exit(1);
}

const ARIA_PERSON_ID = 'sim-aria' as PersonId;
const MILO_PERSON_ID = 'sim-milo' as PersonId;

type EmbedFn = Awaited<ReturnType<typeof createXenovaEmbed>>;
type SpeakerKey = 'aria' | 'milo';

interface TranscriptEntry {
  readonly turn: number;
  readonly speaker: SpeakerKey;
  readonly listener: SpeakerKey;
  readonly text: string;
  readonly messageChunks: readonly string[];
  readonly timestamp: number;
  readonly isSeed?: boolean;
}

interface SnapshotEntry {
  readonly turn: number;
  readonly snapshot: AgentSnapshot;
}

interface BootedAgent {
  readonly name: string;
  readonly port: number;
  readonly store: InMemoryStore;
  readonly viz: VizServerHandle;
  readonly captured: CapturingSink;
  readonly agent: Agent;
}

/**
 * Tee `JournalSink` that records every event into an in-memory buffer while
 * forwarding to a downstream sink (the viz tee, which itself forwards to the
 * store). The buffer is later serialized into the run record so a post-hoc
 * analyzer sees the same journal timeline the dashboard saw live.
 */
class CapturingSink implements JournalSink {
  readonly events: JournalEvent[] = [];
  constructor(private readonly downstream: JournalSink) {}
  async record(event: JournalEvent): Promise<void> {
    this.events.push(event);
    await this.downstream.record(event);
  }
  async recordBatch(events: readonly JournalEvent[]): Promise<void> {
    for (const e of events) this.events.push(e);
    if (this.downstream.recordBatch) {
      await this.downstream.recordBatch(events);
    } else {
      for (const e of events) await this.downstream.record(e);
    }
  }
}

/**
 * Boot one agent with its own store, viz server, capturing sink, and
 * OpenRouter chat callable. Reuses the caller-supplied `embed` function so
 * the Xenova model is loaded once per process.
 */
async function bootAgentWithEmbed(
  name: string,
  character: CharacterConfig,
  port: number,
  embed: EmbedFn,
): Promise<BootedAgent> {
  const store = new InMemoryStore();
  const viz = createVizServer({ characterName: name, underlyingSink: store, port });
  const captured = new CapturingSink(viz.journalSink);
  const generate = createOpenRouterChat({
    apiKey: OPENROUTER_API_KEY as string,
    model: OPENROUTER_MODEL,
    appName: `humanoid-sim-${name.toLowerCase()}`,
  });
  const agent = new Agent({
    store,
    character,
    embeddingDim: XENOVA_EMBEDDING_DIM,
    models: { generation: { generate, embed } },
    journalSink: captured,
  });
  return { name, port, store, viz, captured, agent };
}

/**
 * Boot both agents, seed Aria's opening line, then alternate turns for
 * `SIM_TURNS` iterations. Broadcasts every utterance to both dashboards
 * (self/other tag) and snapshots each agent's view of the other after every
 * turn. On completion or SIGINT, writes `sim-runs/<runId>.json`.
 */
async function main(): Promise<void> {
  console.error('[loading local embedding model — first run downloads ~30MB]');
  const embed = await createXenovaEmbed();
  console.error('[embedding model ready]');

  const aria = await bootAgentWithEmbed('Aria', ariaCharacter, 7373, embed);
  const milo = await bootAgentWithEmbed('Milo', miloCharacter, 7374, embed);

  const activePersonsAria = new Set<PersonId>([MILO_PERSON_ID]);
  const activePersonsMilo = new Set<PersonId>([ARIA_PERSON_ID]);
  aria.viz.attach(aria.agent, activePersonsAria);
  milo.viz.attach(milo.agent, activePersonsMilo);

  const transcript: TranscriptEntry[] = [];
  const snapshotsAria: SnapshotEntry[] = [];
  const snapshotsMilo: SnapshotEntry[] = [];

  const startTs = Date.now();
  const runId = new Date(startTs).toISOString().replace(/[:.]/g, '-');

  console.error(
    `[sim starting — up to ${SIM_TURNS} turns or ${formatDuration(SIM_DURATION_MS)}, whichever ends first]`,
  );
  console.error(`[turn delay ${SIM_TURN_DELAY_MS}ms; background tick every ${SIM_TICK_INTERVAL_MS}ms]`);
  console.error(`[aria dashboard: ${aria.viz.url}]`);
  console.error(`[milo dashboard: ${milo.viz.url}]`);
  console.error(`[seed] ${SIM_SEED}\n`);

  let stopped = false;

  const tickBoth = async (): Promise<void> => {
    try { await aria.agent.tick(MILO_PERSON_ID); } catch (err) { console.error('[tick error for aria]', err); }
    try { await milo.agent.tick(ARIA_PERSON_ID); } catch (err) { console.error('[tick error for milo]', err); }
  };
  const tickTimer = setInterval(() => { void tickBoth(); }, SIM_TICK_INTERVAL_MS);

  const shutdown = async (): Promise<void> => {
    stopped = true;
    clearInterval(tickTimer);
    try { await aria.viz.stop(); } catch { /* ignore */ }
    try { await milo.viz.stop(); } catch { /* ignore */ }
  };

  const finalize = async (): Promise<void> => {
    const outDir = resolve(process.cwd(), 'sim-runs');
    await mkdir(outDir, { recursive: true });
    const filePath = resolve(outDir, `${runId}.json`);
    const record = {
      runId,
      startedAt: startTs,
      endedAt: Date.now(),
      config: {
        turnsRequested: SIM_TURNS,
        turnsActual: transcript.length,
        durationMsRequested: SIM_DURATION_MS,
        durationMsActual: Date.now() - startTs,
        turnDelayMs: SIM_TURN_DELAY_MS,
        tickIntervalMs: SIM_TICK_INTERVAL_MS,
        seed: SIM_SEED,
        model: OPENROUTER_MODEL,
        aria: { personId: ARIA_PERSON_ID, character: aria.name, port: aria.port },
        milo: { personId: MILO_PERSON_ID, character: milo.name, port: milo.port },
      },
      transcript,
      snapshots: { aria: snapshotsAria, milo: snapshotsMilo },
      journal: { aria: aria.captured.events, milo: milo.captured.events },
    };
    await writeFile(filePath, JSON.stringify(record, null, 2), 'utf8');
    console.error(`\n[run record: ${filePath}]`);
  };

  process.on('SIGINT', () => {
    console.error('\n[interrupt — dumping run record and shutting down]');
    void finalize().then(() => shutdown()).finally(() => process.exit(0));
  });

  const seedTs = Date.now();
  transcript.push({
    turn: 1,
    speaker: 'aria',
    listener: 'milo',
    text: SIM_SEED,
    messageChunks: [SIM_SEED],
    timestamp: seedTs,
    isSeed: true,
  });
  aria.viz.broadcast({ kind: 'transcript', timestamp: seedTs, speaker: 'self', text: SIM_SEED });
  milo.viz.broadcast({ kind: 'transcript', timestamp: seedTs, speaker: 'other', text: SIM_SEED });
  console.error(`[turn 1] Aria (seed) → Milo: ${previewText(SIM_SEED)}`);

  let nextInput = SIM_SEED;
  let nextSpeaker: SpeakerKey = 'milo';

  for (let turn = 2; turn <= SIM_TURNS && !stopped; turn++) {
    if (Date.now() - startTs >= SIM_DURATION_MS) {
      console.error(`\n[duration cap ${formatDuration(SIM_DURATION_MS)} reached — stopping cleanly]`);
      break;
    }
    await sleep(SIM_TURN_DELAY_MS);
    if (stopped) break;

    const speaker = nextSpeaker === 'aria' ? aria : milo;
    const listener = nextSpeaker === 'aria' ? milo : aria;
    const listenerPersonId = nextSpeaker === 'aria' ? MILO_PERSON_ID : ARIA_PERSON_ID;

    let replyText = '';
    let chunks: readonly string[] = [];
    try {
      const result = await speaker.agent.turn(listenerPersonId, nextInput);
      chunks = result.messages.map((m) => m.text);
      replyText = chunks.join('\n\n');
    } catch (err) {
      console.error(`[turn ${turn} error for ${speaker.name}]`, err);
      break;
    }

    const ts = Date.now();
    const speakerKey: SpeakerKey = nextSpeaker;
    const listenerKey: SpeakerKey = nextSpeaker === 'aria' ? 'milo' : 'aria';
    transcript.push({
      turn,
      speaker: speakerKey,
      listener: listenerKey,
      text: replyText,
      messageChunks: chunks,
      timestamp: ts,
    });

    speaker.viz.broadcast({ kind: 'transcript', timestamp: ts, speaker: 'self', text: replyText });
    listener.viz.broadcast({ kind: 'transcript', timestamp: ts, speaker: 'other', text: replyText });

    console.error(`[turn ${turn}] ${speaker.name} → ${listener.name}: ${previewText(replyText)}`);

    try {
      const [sa, sm] = await Promise.all([
        aria.agent.snapshot(MILO_PERSON_ID),
        milo.agent.snapshot(ARIA_PERSON_ID),
      ]);
      snapshotsAria.push({ turn, snapshot: sa });
      snapshotsMilo.push({ turn, snapshot: sm });

      if (turn % 10 === 0) {
        const elapsed = Date.now() - startTs;
        console.error(
          `[progress ${turn}/${SIM_TURNS} · ${formatDuration(elapsed)}/${formatDuration(SIM_DURATION_MS)}` +
            ` · aria drift=${sa.baselineDrift.toFixed(3)} bond=${sa.bond.toFixed(2)}` +
            ` · milo drift=${sm.baselineDrift.toFixed(3)} bond=${sm.bond.toFixed(2)}]`,
        );
      }
    } catch (err) {
      console.error(`[snapshot error at turn ${turn}]`, err);
    }

    nextInput = replyText;
    nextSpeaker = nextSpeaker === 'aria' ? 'milo' : 'aria';
  }

  console.error(`\n[sim complete — ${transcript.length} turns]`);
  await finalize();
  await shutdown();
  process.exit(0);
}

function previewText(t: string, max = 80): string {
  const flat = t.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${m.toString().padStart(2, '0')}m`;
  if (m > 0) return `${m}m${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
