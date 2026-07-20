/**
 * Diagnostic dashboard server for the humanoid-agent-demo CLI. Boots a local
 * HTTP + WebSocket surface alongside the chat loop so a browser dashboard can
 * observe the agent's internal state in real time. Exposes a tee `JournalSink`
 * that forwards every event to the caller's underlying sink (typically the
 * `InMemoryStore`, so nothing is lost) and simultaneously broadcasts to all
 * connected WS clients. Every `pollIntervalMs` snapshots each active person
 * via `agent.snapshot(personId)` and broadcasts. Serves a static single-page
 * dashboard from `./public/`. Also exposes a public `broadcast(msg)` escape
 * hatch so external callers can push arbitrary JSON-serializable messages
 * (e.g. the agent-to-agent simulator's transcript entries) to all clients.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

import type { Agent, AgentSnapshot } from '@humanoid/humanoid';
import type { JournalEvent, JournalSink } from '@humanoid/journal';
import type { PersonId } from '@humanoid/types';

/** Configuration for `createVizServer`. */
export interface VizServerOptions {
  readonly port?: number;
  readonly pollIntervalMs?: number;
  readonly characterName: string;
  /**
   * Underlying sink the tee wraps (typically the store). Every event is
   * forwarded here first, then broadcast to WS clients.
   */
  readonly underlyingSink: JournalSink;
}

/** Handle returned by `createVizServer`; used to wire the agent and stop the server. */
export interface VizServerHandle {
  readonly port: number;
  readonly url: string;
  /** Tee-sink that MUST be passed into `new Agent({ journalSink })`. */
  readonly journalSink: JournalSink;
  /**
   * Register the agent + active-persons set after both exist (circular dep
   * between server and agent: the sink is needed to construct the Agent, but
   * the Agent is needed to service snapshot polling).
   */
  attach(agent: Agent, activePersons: ReadonlySet<PersonId>): void;
  /**
   * Broadcast an arbitrary message to every connected client. Wraps
   * `JSON.stringify` in try/catch — unserializable messages are dropped with
   * a `[viz: dropping unserializable message]` warning to stderr. Intended
   * escape hatch for feature-specific messages the server does not know
   * about (e.g. simulator transcript entries).
   */
  broadcast(msg: unknown): void;
  stop(): Promise<void>;
}

/**
 * Known outbound frames. The wire is not closed — external callers may push
 * arbitrary shapes via `broadcast(msg)`; dashboard clients ignore unknown
 * `kind`s. These are the shapes the server itself emits.
 */
type VizOutbound =
  | { kind: 'hello'; character: string; port: number }
  | { kind: 'snapshot'; personId: string; timestamp: number; snapshot: AgentSnapshot }
  | { kind: 'journal'; event: JournalEvent };

const DEFAULT_PORT = 7373;
const DEFAULT_POLL_INTERVAL_MS = 1000;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/**
 * Boot the diagnostic dashboard: HTTP static server + WS broadcaster + snapshot
 * polling loop. Returns a handle whose `journalSink` must be passed into the
 * Agent, and whose `attach` must be called once the Agent exists.
 */
export function createVizServer(opts: VizServerOptions): VizServerHandle {
  const port = opts.port ?? DEFAULT_PORT;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const clients = new Set<WebSocket>();

  // Single fan-out path for every outbound frame (journal, snapshot, and any
  // external `broadcast(msg)` call). Drops sockets on send failure and skips
  // unserializable payloads rather than crashing the caller.
  function broadcast(msg: unknown): void {
    let json: string;
    try {
      json = JSON.stringify(msg);
    } catch (err) {
      console.error('[viz: dropping unserializable message]', err);
      return;
    }
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(json);
      } catch {
        clients.delete(ws);
      }
    }
  }

  // Broadcast-only journal sink; paired with the underlying sink via the tee
  // below so events are persisted before the UI is told about them.
  const broadcasterSink: JournalSink = {
    record(event: JournalEvent) {
      broadcast({ kind: 'journal', event } satisfies VizOutbound);
    },
    recordBatch(events: readonly JournalEvent[]) {
      for (const e of events) broadcast({ kind: 'journal', event: e } satisfies VizOutbound);
    },
  };

  const underlying = opts.underlyingSink;
  const journalSink: JournalSink = {
    async record(event: JournalEvent) {
      await underlying.record(event);
      broadcasterSink.record!(event);
    },
    async recordBatch(events: readonly JournalEvent[]) {
      if (underlying.recordBatch) {
        await underlying.recordBatch(events);
      } else {
        for (const e of events) await underlying.record(e);
      }
      broadcasterSink.recordBatch!(events);
    },
  };

  let attachedAgent: Agent | undefined;
  let attachedPersons: ReadonlySet<PersonId> | undefined;

  const publicDir = fileURLToPath(new URL('./public/', import.meta.url));

  const httpServer: HttpServer = createServer(async (req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0]!;
    const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const resolved = normalize(join(publicDir, relative));

    if (!resolved.startsWith(normalize(publicDir))) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    const ext = extname(resolved).toLowerCase();
    const contentType = CONTENT_TYPES[ext];
    if (!contentType) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    try {
      const body = await readFile(resolved);
      res.statusCode = 200;
      res.setHeader('Content-Type', contentType);
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', async (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));

    // Hello frame stays inline: single-socket target (the just-opened one),
    // not a fan-out — no reason to route through the shared broadcast path.
    try {
      ws.send(JSON.stringify({ kind: 'hello', character: opts.characterName, port } satisfies VizOutbound));
    } catch {
      clients.delete(ws);
      return;
    }

    // Prime the client with current-state snapshots so the dashboard has
    // something to render before the next poll tick.
    if (attachedAgent && attachedPersons) {
      for (const personId of attachedPersons) {
        try {
          const snapshot = await attachedAgent.snapshot(personId);
          ws.send(
            JSON.stringify({
              kind: 'snapshot',
              personId,
              timestamp: Date.now(),
              snapshot,
            } satisfies VizOutbound),
          );
        } catch (err) {
          console.error('[viz: snapshot failed on connect]', personId, err);
        }
      }
    }
  });

  // Snapshot polling loop; no-op until `attach` supplies the agent.
  const pollTimer = setInterval(async () => {
    if (!attachedAgent || !attachedPersons) return;
    for (const personId of attachedPersons) {
      try {
        const snapshot = await attachedAgent.snapshot(personId);
        broadcast({
          kind: 'snapshot',
          personId,
          timestamp: Date.now(),
          snapshot,
        } satisfies VizOutbound);
      } catch (err) {
        console.error('[viz: snapshot poll failed]', personId, err);
      }
    }
  }, pollIntervalMs);

  httpServer.listen(port);

  return {
    port,
    url: `http://localhost:${port}`,
    journalSink,
    attach(agent, activePersons) {
      attachedAgent = agent;
      attachedPersons = activePersons;
    },
    broadcast,
    async stop() {
      clearInterval(pollTimer);
      for (const ws of clients) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      clients.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
