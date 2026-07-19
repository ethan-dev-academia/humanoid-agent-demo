/**
 * Long-horizon CLI chatter for humanoid-sdk. A single-terminal chat surface
 * designed for testing relationship dynamics across many turns: auto-fires
 * Algorithm 2 on a schedule, exposes /snapshot for introspection, and
 * exercises the full affect + memory + plasticity loop.
 *
 * Usage:
 *   cp .env.example .env    (add your OPENROUTER_API_KEY)
 *   pnpm install
 *   pnpm chat
 *
 * Slash commands during a chat:
 *   /snapshot     dump the agent's current view of the relationship
 *   /tick         manually fire the background loop right now
 *   /help         list commands
 *   /quit         exit cleanly
 */

import 'dotenv/config';

import type { PersonId } from '@humanoid/types';
import { Agent } from '@humanoid/humanoid';
import { InMemoryStore } from '@humanoid/ground-store';
import { InMemoryIdentityResolver } from '@humanoid/adapter-core';
import { CliAdapter } from '@humanoid/adapter-cli';

import { character } from './character.js';
import { XENOVA_EMBEDDING_DIM, createOpenRouterChat, createXenovaEmbed } from './providers.js';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? 'anthropic/claude-3.5-sonnet';
const TICK_INTERVAL_MS = Number.parseInt(process.env.TICK_INTERVAL_MS ?? '60000', 10);

if (!OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY is missing.');
  console.error('Copy .env.example → .env and paste your key from https://openrouter.ai/keys.');
  process.exit(1);
}

async function main(): Promise<void> {
  console.error('[loading local embedding model — first run downloads ~30MB]');
  const embed = await createXenovaEmbed();
  console.error('[embedding model ready]');

  const generate = createOpenRouterChat({
    apiKey: OPENROUTER_API_KEY as string,
    model: OPENROUTER_MODEL,
    appName: 'humanoid-agent-demo',
  });

  const store = new InMemoryStore();
  const agent = new Agent({
    store,
    character,
    embeddingDim: XENOVA_EMBEDDING_DIM,
    models: { generation: { generate, embed } },
  });

  const resolver = new InMemoryIdentityResolver();
  const cli = new CliAdapter({ prompt: '> ', surfaceHandle: 'local-user' });

  // Track active persons so the periodic tick has someone to fire on.
  const activePersons = new Set<PersonId>();

  // Background loop scheduler — Algorithm 2 (consolidation, belief revision,
  // plasticity, anticipation, rumination, outreach) fires every N ms for each
  // person we've heard from at least once. Without this the whole cognition
  // tier stays dormant.
  const tickTimer = setInterval(() => {
    void (async () => {
      for (const personId of activePersons) {
        try {
          await agent.tick(personId);
        } catch (err) {
          console.error(`[tick error for ${personId}]`, err);
        }
      }
    })();
  }, TICK_INTERVAL_MS);

  const shutdown = async (): Promise<void> => {
    clearInterval(tickTimer);
    await cli.stop();
  };

  await cli.listen(async (msg) => {
    const text = msg.text.trim();
    if (text.length === 0) return;

    const personId = await resolver.resolve(msg.surface, msg.surfaceHandle);
    activePersons.add(personId);

    // Slash-command interceptor. Commands run outside the agent's turn
    // pipeline — they inspect or trigger state, they don't feed the LLM.
    if (text.startsWith('/')) {
      const [rawCmd, ...args] = text.slice(1).split(/\s+/);
      const cmd = rawCmd?.toLowerCase() ?? '';
      switch (cmd) {
        case 'snapshot': {
          const snap = await agent.snapshot(personId);
          console.error(JSON.stringify(snap, null, 2));
          break;
        }
        case 'tick': {
          console.error('[firing tick manually...]');
          await agent.tick(personId);
          console.error('[tick complete]');
          break;
        }
        case 'help': {
          console.error(
            [
              '  /snapshot   dump the agent’s current view of the relationship',
              '  /tick       fire Algorithm 2 (consolidation, plasticity, rumination, outreach) now',
              '  /help       list commands',
              '  /quit       exit',
            ].join('\n'),
          );
          break;
        }
        case 'quit':
        case 'exit': {
          console.error('[goodbye]');
          await shutdown();
          process.exit(0);
        }
        default: {
          console.error(
            `[unknown command: /${cmd}${args.length > 0 ? ' ' + args.join(' ') : ''} — try /help]`,
          );
        }
      }
      return;
    }

    // Normal chat: run one turn through the agent, print the reply.
    try {
      const { reply } = await agent.turn(personId, text);
      await cli.send(msg.surfaceHandle, msg.conversationId, reply);
    } catch (err) {
      console.error('[turn error]', err);
    }
  });

  // Ctrl-C handler for a clean exit.
  process.on('SIGINT', () => {
    console.error('\n[interrupt — shutting down]');
    void shutdown().finally(() => process.exit(0));
  });

  console.error(
    [
      `[chat started with model ${OPENROUTER_MODEL}]`,
      `[background loop fires every ${TICK_INTERVAL_MS}ms; use /snapshot to inspect]`,
      '[type /help for commands, /quit to exit]',
      '',
    ].join('\n'),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
