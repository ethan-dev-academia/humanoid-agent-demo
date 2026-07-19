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

## Slash commands

Type these mid-chat instead of a normal message:

- `/snapshot` — dump the agent's current view of the relationship: mood brief, valence, arousal, bond, drifted baseline, baseline drift magnitude, top-k salient memories with affect tags, timestamps. This is the ergonomic API for answering "what does the agent currently feel about me?"
- `/tick` — fire Algorithm 2 (consolidation, plasticity, rumination, outreach) right now instead of waiting for the interval.
- `/help` — list commands.
- `/quit` — exit cleanly.

## What to watch for in a long conversation

Because the background loop is auto-firing:

- **Bond drifts up or down** as plasticity (§12, Eq. 19) integrates lived affect against you specifically. Aria's per-person warmth is not static.
- **Baseline drifts** as plasticity (Eq. 18) moves the temperament setpoint. `/snapshot` shows `baselineDrift` — the L2 magnitude of `‖b_drifted − b_frozen‖`. High baseline drift = the agent has become someone different from who it started as.
- **Rumination shows up in `globalAffect`** — negative-affect unresolved memories get periodically re-touched even without a triggering utterance, so a rough exchange colors the agent's mood for the next hour of chat even after you switch topics.
- **Retrieval quality is affect-conditioned** — the agent recalls episodes that are semantically similar AND mood-congruent. If you're calm, retrieval is broad; if you've made the agent anxious, retrieval collapses onto anxious memories (Bower 1981 mechanism).
- **The agent's own words become memory** — replies are embedded and stored as `role: 'agent'` episodes, so lore holds up across turns. Ask the agent something in turn 40 that it invented in turn 5; it should remember its own claim.

## Configuration

Edit `src/character.ts` to change the persona. The seven-dimension affect vector is `[joy, sadness, anger, fear, surprise, disgust, trust]`; tune `baseline`, `halfLife`, `gain`, `valenceWeights`, `eMax`, `beta`, and `compartmentalizationLeak` to shape the character.

Edit `.env`:

- `OPENROUTER_MODEL` — any model OpenRouter serves (`anthropic/claude-3.5-sonnet`, `openai/gpt-4o`, `meta-llama/llama-3.1-70b-instruct`, etc.).
- `TICK_INTERVAL_MS` — how often the background loop fires. Default 60000 (1 min).

## Persistence (limitations)

`InMemoryStore` is exactly what its name says — the relationship dies when the process exits. This is fine for testing long-conversation dynamics within one session (which is the primary use case for this demo) but not for a persistent companion.

To persist across restarts, swap `InMemoryStore` for a store backed by SQLite, Postgres, or the SDK's `MinimalStore` factory with your own durable adapters. The SDK's `PostgresStore` scaffold has the schema; the connection wiring is deliberately stubbed pending a real deployment target.

## Cross-surface identity

The demo uses one terminal, one PersonId. In a multi-surface deployment (Discord + iMessage + WhatsApp all resolving to the same human), the `InMemoryIdentityResolver.link(personId, surface, handle)` call is where you'd operator-merge a Discord snowflake and a phone number into one PersonId — the agent then maintains one relationship across every surface.

See `humanoid-sdk/packages/adapters/*` for the surface adapters (CLI is fully implemented; Discord / iMessage / WhatsApp / game-chat are scaffolds with documented integration contracts).
