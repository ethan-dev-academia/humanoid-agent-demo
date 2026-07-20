# humanoid-agent-demo

A long-horizon CLI chat surface for [humanoid-sdk](https://github.com/The-Resonance-Lab/humanoid-sdk). Designed as a **relationship testing bench** — spin up a persona, chat with it across many turns, watch its affect drift, memory graph fill in, plasticity move the temperament baseline, and (with `/snapshot`) inspect the whole relationship at any point.

## Setup

This demo consumes the SDK via pnpm workspace links, so `humanoid-sdk` must be cloned as a sibling directory:

```
Github/
  humanoid-sdk/            (this repo — built)
  humanoid-agent-demo/     (this repo)
```

Then:

```bash
# In humanoid-sdk — make sure it's built at least once
cd humanoid-sdk && pnpm install && pnpm -r build

# In humanoid-agent-demo
cd ../humanoid-agent-demo
cp .env.example .env
# → paste your OPENROUTER_API_KEY into .env
pnpm install
pnpm chat
```

First run downloads ~30MB of local embedding model weights (Xenova/all-MiniLM-L6-v2, ONNX). Subsequent runs are offline for embedding.

## What the demo actually wires

- **Generation**: OpenRouter (`anthropic/claude-3.5-sonnet` by default). Set `OPENROUTER_MODEL` in `.env` to any OpenRouter model.
- **Embedding**: local Xenova/transformers pipeline (384-dim). No second API key needed.
- **Store**: `InMemoryStore` — the relationship survives across many turns *within one process* but not across restarts. See the persistence note below.
- **Adapter**: `CliAdapter` — one persona, one terminal, one PersonId.
- **Background loop**: fires every 60s (configurable via `TICK_INTERVAL_MS`) so consolidation, plasticity, rumination, and outreach actually run during a long chat instead of only-when-you-remember-to-call-it.
- **Diagnostic dashboard**: local HTTP + WebSocket at http://localhost:7373. Open in a browser for live introspection (see below).

## Slash commands

Type these mid-chat instead of a normal message:

- `/snapshot` — dump the agent's current view of the relationship: mood brief, valence, arousal, bond, drifted baseline, baseline drift magnitude, top-k salient memories with affect tags, timestamps. This is the ergonomic API for answering "what does the agent currently feel about me?"
- `/tick` — fire Algorithm 2 (consolidation, plasticity, rumination, outreach) right now instead of waiting for the interval.
- `/help` — list commands.
- `/quit` — exit cleanly.

## Diagnostic dashboard

When you run `pnpm chat`, a local diagnostic server also boots at **http://localhost:7373**. Open it in a browser — the terminal stays the input surface; the browser is a read-only control room.

Panels:

- **Mood brief** — the categorical phrase the SDK exposes to Generation ("quietly-warm", "on-edge", etc.), plus how stale the last snapshot is.
- **Baseline temperament (drifted)** — Aria's 7-dimension `driftedBaseline` after plasticity (§12 Eq. 18). Bars split around a midline; positive-valence emotions render green, negative-valence render red, surprise is neutral. Watch it drift over hundreds of turns.
- **Baseline drift ‖b − b₀‖** — L2 magnitude of how far the drifted baseline has moved from the frozen character baseline. If this creeps up, the persona is becoming someone different.
- **Valence / arousal / bond** — hand-rolled canvas line charts over the last ~120 snapshots (default snapshot cadence is 1s). Valence and bond axes are signed and cross zero; arousal is a positive magnitude.
- **Top-k salient memories** — the same list `/snapshot` prints, updated live. Each card shows the categorical affect tag, the gist/excerpt, salience, and age.
- **Journal event stream** — every module's `emit(...)` call (predictive-core, affect-dynamics, encoding-gate, memory-retrieval, generation, consolidation, plasticity, anticipation, outreach) as it happens, with the payload truncated. Auto-scrolls; scroll up to pause and inspect.

The dashboard uses a `TeeJournalSink` under the hood — every event still lands in the store's own case-file record, and *also* streams over WebSocket to the browser. Nothing is dropped from persistence.

No installation step for the dashboard — it's static HTML served by the demo process, no CDN, works offline.

## Agent-to-agent simulation

Two Agents can also talk to each other, so you can watch cross-agent drift, mutual influence, and convergence/divergence dynamics as they unfold. This is the primary use case for validating the paper's long-horizon claims — a human on the other end is variable and slow; two agents can run for 30–45 minutes uninterrupted and produce a machine-readable run record for analysis.

A full batch is tuned for **long-horizon change**: default is up to 500 turns or 40 minutes of wall-clock, whichever ends first. Plasticity (§12 Eq. 18), consolidation, belief-revision, and rumination all live on the background tick — the sim fires Algorithm 2 for both agents every 60 seconds during the run so the cognition tier is actually working, not just the live path. Short runs (~5 min) show live-path affect wobble but almost no baseline drift; a full 40-min batch is where the setpoint actually moves.

```bash
pnpm sim
```

Boots **two** agents with contrasting personas:

- **Aria** — warm, dry, trusting-lean baseline (from `src/character.ts`).
- **Milo** — melancholic, anxious, cool-trust counterpart (from `src/character-milo.ts`). Baseline mood is roughly the shadow of Aria's; sadness and fear have long half-lives so bad turns leave a residue.

Each agent gets its own diagnostic dashboard on its own port:

- Aria's dashboard: **http://localhost:7373**
- Milo's dashboard: **http://localhost:7374**

Open both in a browser side-by-side. Watch:

- **The transcript panel** — same conversation appears in both dashboards, but each shows it from that agent's POV (own messages tagged `self`, counterpart's tagged `other`).
- **Cross-agent affect drift** — does Aria's warmth pull Milo up? Does Milo's melancholy pull Aria down? The valence / arousal / bond time-series in each dashboard tell the story.
- **Bond asymmetry** — one agent's bond may grow while the other's shrinks. This is common when temperaments diverge.
- **Baseline drift** — after many turns, the drifted temperament `b` moves; a persistent negative peer can shift the setpoint.
- **Rumination** — Milo is tuned for long-half-life sadness and higher compartmentalization leak; expect his mood to hold negative residue across turns even when Aria is trying to lift.

### Configuration

All optional; env vars in `.env` or your shell:

- `SIM_TURNS` — hard cap on turn count. Default `500`. Combined with the duration cap; whichever trips first ends the batch.
- `SIM_DURATION_MS` — hard cap on wall-clock in milliseconds. Default `2400000` (40 minutes). Set to `1800000` for 30 min, `3600000` for a full hour. This is the primary knob for how long a batch runs — at ~5–8s per turn including delay, a 40-minute batch typically produces 250–350 completed turns.
- `SIM_TURN_DELAY_MS` — pause between turns in milliseconds. Default `2000`. Two agents at ~1 LLM call each per turn is ~2 requests/turn; the delay is a courtesy to OpenRouter rate limits and gives the tick timer + dashboards room to breathe.
- `SIM_TICK_INTERVAL_MS` — how often the background loop (Algorithm 2 — consolidation, plasticity, rumination, outreach) fires for BOTH agents during the run. Default `60000` (60s). Long-horizon change comes from the tick, not the turn — do not turn this off if you actually want to see baseline drift.
- `SIM_SEED` — Aria's opening utterance. Default `"hey — how are you doing?"`. Use something loaded ("i had a rough day") to see how quickly a persona colors the whole conversation.

Every 10 turns the sim prints a progress line to stderr with elapsed time, projected end, and each agent's current baseline drift + bond, so you can eyeball how the batch is moving without opening the dashboards.

### Run records

Every sim dumps a JSON file to `sim-runs/<ISO-timestamp>.json` (gitignored). Structure:

```json
{
  "runId": "2026-07-20T18-23-01-234Z",
  "startedAt": 1737392581234,
  "endedAt":   1737392621890,
  "config": { "turnsRequested": 20, "turnsActual": 20, "turnDelayMs": 2000, "seed": "...", "model": "...", "aria": {...}, "milo": {...} },
  "transcript": [
    { "turn": 1, "speaker": "aria", "listener": "milo", "text": "...", "messageChunks": ["..."], "timestamp": 1737..., "isSeed": true },
    { "turn": 2, "speaker": "milo", "listener": "aria", "text": "...", "messageChunks": ["...", "..."], "timestamp": 1737... },
    ...
  ],
  "snapshots": {
    "aria": [ { "turn": 2, "snapshot": { ...AgentSnapshot } }, ... ],
    "milo": [ { "turn": 2, "snapshot": { ...AgentSnapshot } }, ... ]
  },
  "journal": {
    "aria": [ ...every JournalEvent Aria emitted... ],
    "milo": [ ...every JournalEvent Milo emitted... ]
  }
}
```

This is the substrate for downstream analysis: plot per-turn valence/arousal/bond across the full run, cluster journal events by module, compare snapshot trajectories under different seeds or personas.

Ctrl-C at any time cleanly writes the record with whatever turns completed.

**Watch the journal for safety events.** The SDK guards the affect / retrieval / plasticity path against numerical corruption (see humanoid-sdk `NumericSafety`). Four warning events show up in the dashboard's Journal tab if any guard fires — `normalize-fallback`, `recall-affect-clamped`, `reject-affect`, `mood-frozen`. On a healthy run these should be rare; a sudden burst of any of them (especially `normalize-fallback` clustered around one turn) is a strong signal something in the persona tuning or retrieval scoring has pushed the pipeline into a corner. Long batches produced silently-degenerate transcripts in earlier versions (both agents collapsing to bare "yeah" for hundreds of turns while internal state was frozen) — the guards fire before that happens now.

## What to watch for in a long conversation

Because the background loop is auto-firing:

- **Bond drifts up or down** as plasticity (§12, Eq. 19) integrates lived affect against you specifically. Aria's per-person warmth is not static.
- **Baseline drifts** as plasticity (Eq. 18) moves the temperament setpoint. `/snapshot` shows `baselineDrift` — the L2 magnitude of `‖b_drifted − b_frozen‖`. High baseline drift = the agent has become someone different from who it started as.
- **Rumination shows up in `globalAffect`** — negative-affect unresolved memories get periodically re-touched even without a triggering utterance, so a rough exchange colors the agent's mood for the next hour of chat even after you switch topics.
- **Retrieval quality is affect-conditioned** — the agent recalls episodes that are semantically similar AND mood-congruent. If you're calm, retrieval is broad; if you've made the agent anxious, retrieval collapses onto anxious memories (Bower 1981 mechanism).
- **The agent's own words become memory** — replies are embedded and stored as `role: 'agent'` episodes, so lore holds up across turns. Ask the agent something in turn 40 that it invented in turn 5; it should remember its own claim.
- **Aria texts in bursts.** She'll sometimes send one reply, sometimes two or three back-to-back. This is not a demo behavior or an adapter policy — it's the SDK. `Agent.turn` returns a `TurnMessage[]` with typing/delay hints computed inside the agent; the CLI renders each chunk after a dim `...` indicator and a short pause. The same cadence appears on every surface adapter (Discord, iMessage, WhatsApp) because the timing is intrinsic to the SDK's delivery contract, not to individual adapters.

## Configuration

Edit `src/character.ts` to change the persona. The seven-dimension affect vector is `[joy, sadness, anger, fear, surprise, disgust, trust]`; tune `baseline`, `halfLife`, `gain`, `valenceWeights`, `eMax`, `beta`, and `compartmentalizationLeak` to shape the character.

Edit `.env`:

- `OPENROUTER_MODEL` — any model OpenRouter serves (`anthropic/claude-3.5-sonnet`, `openai/gpt-4o`, `meta-llama/llama-3.1-70b-instruct`, etc.).
- `TICK_INTERVAL_MS` — how often the background loop fires. Default 60000 (1 min).

## Why Aria doesn't drift into AI-assistant mode

Aria's persona brief is short — a few lines of temperament and voice. It never says "don't call yourself an AI," "don't offer to help," "don't do therapist framings." It doesn't need to. The SDK enforces those identity safeguards behind the scenes: a `# Rules` block is prepended to every generation prompt with no configuration path to disable it. That's why a thin persona brief still holds up across hundreds of turns without regressing into assistant register — the demo gets to describe who Aria *is*, and the SDK guarantees what she *isn't*.

## Persistence (limitations)

`InMemoryStore` is exactly what its name says — the relationship dies when the process exits. This is fine for testing long-conversation dynamics within one session (which is the primary use case for this demo) but not for a persistent companion.

To persist across restarts, swap `InMemoryStore` for a store backed by SQLite, Postgres, or the SDK's `MinimalStore` factory with your own durable adapters. The SDK's `PostgresStore` scaffold has the schema; the connection wiring is deliberately stubbed pending a real deployment target.

## Cross-surface identity

The demo uses one terminal, one PersonId. In a multi-surface deployment (Discord + iMessage + WhatsApp all resolving to the same human), the `InMemoryIdentityResolver.link(personId, surface, handle)` call is where you'd operator-merge a Discord snowflake and a phone number into one PersonId — the agent then maintains one relationship across every surface.

See `humanoid-sdk/packages/adapters/*` for the surface adapters (CLI is fully implemented; Discord / iMessage / WhatsApp / game-chat are scaffolds with documented integration contracts).
