/**
 * Diagnostic dashboard server for the humanoid-agent-demo CLI. Boots a local
 * HTTP + WebSocket surface alongside the chat loop so a browser dashboard can
 * observe the agent's internal state in real time. Exposes a tee `JournalSink`
 * that forwards every event to the caller's underlying sink (typically the
 * `InMemoryStore`, so nothing is lost) and simultaneously broadcasts to all
 * connected WS clients. Every `pollIntervalMs` snapshots each active person
 * via `agent.snapshot(personId)` and broadcasts. Serves a static single-page
 * dashboard from `./public/`.
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
  stop(): Promise<void>;
}

/** Outbound wire protocol. Frozen — dashboard clients depend on the exact shape. */
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
 * Broadcast-only sink: holds the WS client set and pushes every event as a
 * JSON `journal` frame. Never persists — pair it with a real sink via
 * `TeeJournalSink` so events aren't lost.
 */
class BroadcastJournalSink implements JournalSink {
  constructor(private readonly clients: Set<WebSocket>) {}

  record(event: JournalEvent): void {
    broadcast(this.clients, { kind: 'journal', event });
  }

  recordBatch(events: readonly JournalEvent[]): void {
    for (const e of events) broadcast(this.clients, { kind: 'journal', event: e });
  }
}

/**
 * Fan-out sink: forwards to an underlying sink (durability) and to a broadcast
 * sink (dashboard). Underlying is awaited first so persistence errors surface
 * before we tell the UI anything happened.
 */
class TeeJournalSink implements JournalSink {
  constructor(
    private readonly underlying: JournalSink,
    private readonly broadcaster: BroadcastJournalSink,
  ) {}

  async record(event: JournalEvent): Promise<void> {
    await this.underlying.record(event);
    this.broadcaster.record(event);
  }

  async recordBatch(events: readonly JournalEvent[]): Promise<void> {
    if (this.underlying.recordBatch) {
      await this.underlying.recordBatch(events);
    } else {
      for (const e of events) await this.underlying.record(e);
    }
    this.broadcaster.recordBatch(events);
  }
}

/** Best-effort JSON send; drops the socket from the set on any failure. */
function broadcast(clients: Set<WebSocket>, message: VizOutbound): void {
  let json: string;
  try {
    json = JSON.stringify(message);
  } catch (err) {
    // Payloads may contain non-serializable values (functions, class instances);
    // skip them rather than crash the loop.
    console.error('[viz: dropping unserializable event]', err);
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

/**
 * Boot the diagnostic dashboard: HTTP static server + WS broadcaster + snapshot
 * polling loop. Returns a handle whose `journalSink` must be passed into the
 * Agent, and whose `attach` must be called once the Agent exists.
 */
export function createVizServer(opts: VizServerOptions): VizServerHandle {
  const port = opts.port ?? DEFAULT_PORT;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const clients = new Set<WebSocket>();
  const broadcaster = new BroadcastJournalSink(clients);
  const journalSink = new TeeJournalSink(opts.underlyingSink, broadcaster);

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

    // Hello frame: identifies the character and confirms the port the client hit.
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
        broadcast(clients, {
          kind: 'snapshot',
          personId,
          timestamp: Date.now(),
          snapshot,
        });
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
