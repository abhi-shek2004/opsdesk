/**
 * Live updates over Server-Sent Events.
 *
 * Every API instance LISTENs on a Postgres channel; writers NOTIFY inside their
 * transaction (delivered only on commit). This fans out across any number of API
 * processes without Redis. Messages are hints containing ids only — clients
 * refetch through the normal, authorized endpoints, so a stale membership on an
 * open connection can at most reveal that "some item id changed".
 */
import type { ServerResponse } from 'node:http';
import pg from 'pg';
import { config } from '../config.js';
import type { Actor } from '../domain/types.js';
import { invalidateSession, invalidateUser, loadMemberships } from '../services/auth.js';
import { LIVE_CHANNEL, type LiveMessage } from './outbox.js';

interface Client {
  actor: Actor;
  res: ServerResponse;
}

class LiveHub {
  private clients = new Set<Client>();
  private listener: pg.Client | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private stopped = false;

  async start() {
    this.stopped = false;
    await this.connect();
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) c.res.write(': ping\n\n');
    }, 25_000);
  }

  private async connect() {
    const listener = new pg.Client({ connectionString: config.databaseUrl });
    listener.on('notification', (n) => {
      if (!n.payload) return;
      try {
        this.dispatch(JSON.parse(n.payload) as LiveMessage);
      } catch {
        /* ignore malformed */
      }
    });
    listener.on('error', () => {
      // Reconnect with a short delay; clients keep their SSE connections.
      if (this.stopped) return;
      this.listener = null;
      setTimeout(() => this.connect().catch(() => {}), 2000);
    });
    await listener.connect();
    await listener.query(`LISTEN ${LIVE_CHANNEL}`);
    this.listener = listener;
  }

  private dispatch(msg: LiveMessage) {
    if (msg.kind === 'session') return invalidateSession(msg.tokenHash);
    if (msg.kind === 'membership') {
      invalidateUser(msg.userId);
      // Re-scope this user's open connections so they stop (or start) receiving team events,
      // and tell their browser to refetch what it can see.
      const mine = [...this.clients].filter((c) => c.actor.id === msg.userId);
      if (mine.length) {
        loadMemberships(msg.userId)
          .then((memberships) => {
            for (const c of mine) {
              c.actor = { ...c.actor, memberships };
              send(c.res, 'membership', {});
            }
          })
          .catch(() => {});
      }
      return;
    }
    for (const c of this.clients) {
      if (msg.kind === 'item') {
        if (!c.actor.isAdmin && !c.actor.memberships.has(msg.teamId)) continue;
        send(c.res, 'item', { itemId: msg.itemId, version: msg.version, actorId: msg.actorId, event: msg.event });
      } else if (msg.kind === 'notification' && msg.userId === c.actor.id) {
        send(c.res, 'notification', {});
      }
    }
  }

  add(actor: Actor, res: ServerResponse) {
    const client = { actor, res };
    this.clients.add(client);
    send(res, 'ready', { ok: true });
    return () => this.clients.delete(client);
  }

  async stop() {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients) c.res.end();
    this.clients.clear();
    await this.listener?.end().catch(() => {});
  }
}

function send(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export const liveHub = new LiveHub();
