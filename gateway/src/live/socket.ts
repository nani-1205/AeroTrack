// Live tracking WebSocket (`websocket.path`, default /ws).
//
// Client → server                          Server → client
//   {type:"subscribe", icao24:[…1–5]}        {type:"ready"}                       after auth
//   {type:"unsubscribe"}                     {type:"subscribed", airline, flights, watchTtlSeconds}
//   {type:"ping"}                            {type:"positions", ts, flights[], removed[]}
//                                            {type:"ended"}                       every tracked flight left
//                                            {type:"error", error, message}       e.g. mixed_airlines
//                                            {type:"pong"}
// Close codes: 4400 bad message · 4401 unauthenticated/expired · 4403 origin · 4429 rate · 4503 auth down.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Counter, Gauge } from 'prom-client';
import type { RawData, WebSocket } from 'ws';
import { AuthError, type Principal, type TokenVerifier } from '../auth.js';
import type { GatewayConfig } from '../config.js';
import { registry } from '../metrics.js';
import type { PositionBus, Unsubscribe } from './bus.js';

export const CloseCode = {
  BadMessage: 4400,
  Unauthorized: 4401,
  Forbidden: 4403,
  RateLimited: 4429,
  Unavailable: 4503,
} as const;

interface Flight {
  icao24: string;
  airlineIcao: string;
  [field: string]: unknown;
}

interface PositionBatch {
  airline: string;
  ts: number;
  flights: Flight[];
  removed: string[];
}

interface WatchResponse {
  airline: { icao: string } & Record<string, unknown>;
  flights: Flight[];
  watchTtlSeconds: number;
}

interface ApiError {
  error: string;
  message: string;
  inactive?: string[];
}

type WatchResult = { ok: true; body: WatchResponse } | { ok: false; status: number; body: ApiError };

const ICAO24 = /^[0-9a-f]{6}$/;
const MAX_BUFFERED_BYTES = 1 << 20; // skip position frames for clients this far behind

const connections = new Gauge({ name: 'gateway_ws_connections', help: 'Open live-tracking sockets.', registers: [registry] });
const subscriptions = new Gauge({ name: 'gateway_ws_subscriptions', help: 'Sockets currently tracking flights.', registers: [registry] });
const frames = new Counter({
  name: 'gateway_ws_frames_total',
  help: 'Live-tracking frames by direction and type.',
  labelNames: ['direction', 'type'] as const,
  registers: [registry],
});

/** Usage events for analytics (Redis stream `events:tracking`). Best-effort: never blocks tracking. */
export interface TrackingEvents {
  publish(fields: Record<string, string>): void;
}

export interface LiveSocketDeps {
  cfg: GatewayConfig;
  verifier: TokenVerifier;
  bus: PositionBus;
  events?: TrackingEvents;
}

export function registerLiveSocket(app: FastifyInstance, deps: LiveSocketDeps) {
  app.get(deps.cfg.websocket.path, { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    new LiveSession(socket, req, deps);
  });
}

class LiveSession {
  private principal: Principal | null = null;
  private ids = new Set<string>();
  private unsubscribe: Unsubscribe | null = null;
  private keepalive: NodeJS.Timeout | null = null;
  private readonly heartbeat: NodeJS.Timeout;
  private alive = true;
  private closed = false;
  private rate = { windowStart: Date.now(), count: 0 };
  /** Serialises auth + message handling so frames are processed in order. */
  private queue: Promise<void>;

  constructor(
    private readonly socket: WebSocket,
    private readonly req: FastifyRequest,
    private readonly deps: LiveSocketDeps,
  ) {
    connections.inc();
    this.queue = this.authenticate();
    socket.on('message', (data: RawData) => {
      this.queue = this.queue.then(() => this.onMessage(data)).catch((err: unknown) => {
        req.log.error({ err }, 'live socket message failed');
      });
    });
    socket.on('pong', () => (this.alive = true));
    socket.on('close', () => void this.dispose());
    socket.on('error', (err: Error) => req.log.warn({ err }, 'live socket error'));

    this.heartbeat = setInterval(() => {
      if (!this.alive) return socket.terminate();
      this.alive = false;
      socket.ping();
    }, deps.cfg.websocket.heartbeatSeconds * 1000);
    this.heartbeat.unref(); // never keep the process alive just for heartbeats
  }

  // ------------------------------------------------------------- lifecycle

  private async authenticate(): Promise<void> {
    const origin = this.req.headers.origin;
    if (origin && !this.deps.cfg.cors.origins.includes(origin)) {
      return this.close(CloseCode.Forbidden, 'origin not allowed');
    }
    try {
      const { verifier } = this.deps;
      this.principal = await verifier.verify(verifier.extractToken(this.req, 'user'), 'user');
      this.send({ type: 'ready' });
    } catch (err) {
      const unavailable = err instanceof AuthError && err.kind === 'unavailable';
      if (unavailable) this.req.log.error({ err }, 'live socket: cannot verify token');
      this.close(unavailable ? CloseCode.Unavailable : CloseCode.Unauthorized, unavailable ? 'auth unavailable' : 'unauthorized');
    }
  }

  private async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    connections.dec();
    await this.stopTracking();
  }

  private close(code: number, reason: string): void {
    if (this.closed) return;
    this.socket.close(code, reason);
  }

  private send(message: { type: string } & Record<string, unknown>): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(message));
    frames.inc({ direction: 'out', type: message.type });
  }

  // -------------------------------------------------------------- messages

  private async onMessage(data: RawData): Promise<void> {
    if (this.closed || !this.principal) return;
    if (!this.withinRate()) return this.close(CloseCode.RateLimited, 'too many messages');

    let msg: { type?: unknown; icao24?: unknown };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return this.close(CloseCode.BadMessage, 'invalid JSON');
    }
    frames.inc({ direction: 'in', type: typeof msg.type === 'string' ? msg.type : 'invalid' });

    switch (msg.type) {
      case 'subscribe':
        return this.subscribe(msg.icao24);
      case 'unsubscribe':
        await this.stopTracking();
        return this.send({ type: 'unsubscribed' });
      case 'ping':
        return this.send({ type: 'pong' });
      default:
        return this.send({ type: 'error', error: 'bad_message', message: 'unknown message type' });
    }
  }

  private withinRate(): boolean {
    const now = Date.now();
    if (now - this.rate.windowStart > 10_000) this.rate = { windowStart: now, count: 0 };
    return ++this.rate.count <= this.deps.cfg.websocket.maxMessagesPer10s;
  }

  private async subscribe(raw: unknown): Promise<void> {
    const max = this.deps.cfg.websocket.maxFlightsPerClient;
    const ids = Array.isArray(raw)
      ? [...new Set(raw.filter((v): v is string => typeof v === 'string').map((v) => v.trim().toLowerCase()))]
      : [];
    if (ids.length === 0 || ids.length > max || !ids.every((id) => ICAO24.test(id))) {
      return this.send({ type: 'error', error: 'invalid_selection', message: `select between 1 and ${max} flights` });
    }

    const result = await this.watch(ids);
    if (!result.ok) return this.send({ type: 'error', error: result.body.error, message: result.body.message });

    await this.stopTracking();
    const airline = result.body.airline.icao;
    this.ids = new Set(ids);
    this.unsubscribe = await this.deps.bus.subscribe(`trk:pos:${airline}`, (payload) => this.onBatch(payload));
    subscriptions.inc();

    const ttl = result.body.watchTtlSeconds;
    this.keepalive = setInterval(() => void this.refreshWatch(), Math.max(5, Math.floor(ttl / 2)) * 1000);
    this.send({ type: 'subscribed', airline: result.body.airline, flights: result.body.flights, watchTtlSeconds: ttl });
    this.deps.events?.publish({
      type: 'track.start',
      userId: this.principal!.sub,
      airline,
      icao24s: JSON.stringify(ids),
      callsigns: JSON.stringify(result.body.flights.map((f) => String(f['callsign'] ?? f.icao24))),
      at: new Date().toISOString(),
    });
  }

  private async stopTracking(): Promise<void> {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    this.ids.clear();
    if (unsubscribe) {
      subscriptions.dec();
      await unsubscribe();
    }
  }

  private onBatch(payload: string): void {
    let batch: PositionBatch;
    try {
      batch = JSON.parse(payload);
    } catch {
      return;
    }
    const flights = batch.flights.filter((f) => this.ids.has(f.icao24));
    const removed = batch.removed.filter((id) => this.ids.has(id));
    this.forget(removed);
    if (removed.length === 0 && (flights.length === 0 || this.socket.bufferedAmount > MAX_BUFFERED_BYTES)) return;
    this.send({ type: 'positions', ts: batch.ts, flights, removed });
    if (this.ids.size === 0) void this.end();
  }

  private forget(ids: string[]): void {
    for (const id of ids) this.ids.delete(id);
  }

  private async end(): Promise<void> {
    await this.stopTracking();
    this.send({ type: 'ended' });
  }

  /** Keeps the selection watched; closes when the access token expires so the client refreshes. */
  private async refreshWatch(): Promise<void> {
    if (!this.principal || this.ids.size === 0) return;
    if (Date.now() / 1000 >= this.principal.expiresAt) return this.close(CloseCode.Unauthorized, 'token expired');

    let result = await this.watch([...this.ids]);
    if (!result.ok && result.body.error === 'not_active' && result.body.inactive?.length) {
      const gone = result.body.inactive.filter((id) => this.ids.has(id));
      this.forget(gone);
      this.send({ type: 'positions', ts: Math.floor(Date.now() / 1000), flights: [], removed: gone });
      if (this.ids.size === 0) return this.end();
      result = await this.watch([...this.ids]);
    }
    if (!result.ok) this.req.log.warn({ status: result.status, error: result.body.error }, 'live socket: watch refresh failed');
  }

  private async watch(ids: string[]): Promise<WatchResult> {
    const p = this.principal!;
    try {
      const res = await fetch(this.deps.cfg.websocket.watchUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-token': this.deps.cfg.internalToken,
          'x-request-id': String(this.req.id),
          'x-user-id': p.sub,
          'x-user-role': p.role,
          'x-session-id': p.sessionId,
        },
        body: JSON.stringify({ icao24: ids }),
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await res.json().catch(() => ({}))) as WatchResponse & ApiError;
      if (res.ok) return { ok: true, body };
      return {
        ok: false,
        status: res.status,
        body: { error: body.error ?? 'unavailable', message: body.message ?? 'live tracking unavailable', inactive: body.inactive },
      };
    } catch (err) {
      this.req.log.error({ err }, 'live socket: tracking-service unreachable');
      return { ok: false, status: 503, body: { error: 'unavailable', message: 'live tracking temporarily unavailable' } };
    }
  }
}
