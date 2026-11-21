import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { WebSocket } from 'ws';
import { buildServer } from '../server.js';
import { PORTAL_ORIGIN, USER_AUD, testConfig, testKeys } from '../test-support.js';
import { MemoryPositionBus } from './bus.js';

// Fake tracking-service: ids starting with "a" belong to AIC, "b" to BAW; "dddddd" has landed.
let upstream: Server;
let watchCalls: { ids: string[]; headers: IncomingHttpHeaders }[] = [];
let app: FastifyInstance;
let redis: Redis;
let bus: MemoryPositionBus;
let userToken: string;
let wsUrl: string;
const published: Record<string, string>[] = [];

before(async () => {
  upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const ids: string[] = JSON.parse(raw).icao24;
      watchCalls.push({ ids, headers: req.headers });
      res.setHeader('content-type', 'application/json');
      const airlines = new Set(ids.map((id) => (id.startsWith('a') ? 'AIC' : 'BAW')));
      if (ids.includes('dddddd')) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: 'not_active', message: 'not active any more: dddddd', inactive: ['dddddd'] }));
      }
      if (airlines.size > 1) {
        res.statusCode = 422;
        return res.end(JSON.stringify({ error: 'mixed_airlines', message: 'all selected flights must belong to the same airline' }));
      }
      const airline = [...airlines][0];
      res.end(JSON.stringify({
        airline: { icao: airline, name: airline === 'AIC' ? 'Air India Limited' : 'British Airways' },
        flights: ids.map((icao24) => ({ icao24, airlineIcao: airline, callsign: `${airline}1` })),
        watchTtlSeconds: 60,
      }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const keys = await testKeys();
  userToken = await keys.sign(USER_AUD);
  bus = new MemoryPositionBus();
  redis = new Redis({ host: '127.0.0.1', port: 1, lazyConnect: true, enableOfflineQueue: false, retryStrategy: () => null });
  redis.on('error', () => {});
  app = await buildServer(testConfig(target), redis, {
    keySet: keys.keySet,
    bus,
    events: { publish: (fields) => published.push(fields) },
    logger: false,
  });
  // Real sockets (not injectWS): disconnect handling must be exercised over an actual connection.
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  wsUrl = `${address.replace('http', 'ws')}/ws`;
});

after(async () => {
  await app?.close();
  redis?.disconnect();
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
});

/** Opens a socket and queues every frame so tests can await them in order. */
async function connect(headers: Record<string, string> = { cookie: `aerotrack_at=${userToken}`, origin: PORTAL_ORIGIN }) {
  const ws = new WebSocket(wsUrl, { headers });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const frames: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', (data) => {
    frames.push(JSON.parse(data.toString()));
    waiters.splice(0).forEach((w) => w());
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  async function next(type: string, timeoutMs = 2000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = frames.findIndex((f) => f['type'] === type);
      if (i >= 0) return frames.splice(i, 1)[0]!;
      if (Date.now() > deadline) throw new Error(`no "${type}" frame; got ${JSON.stringify(frames)}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }
  const send = (msg: unknown) => ws.send(JSON.stringify(msg));
  return { ws, next, send, closed, frames };
}

describe('live tracking socket', () => {
  it('closes unauthenticated connections with 4401', async () => {
    const { closed } = await connect({ origin: PORTAL_ORIGIN });
    assert.equal((await closed).code, 4401);
  });

  it('closes connections from foreign origins with 4403', async () => {
    const { closed } = await connect({ cookie: `aerotrack_at=${userToken}`, origin: 'https://evil.example' });
    assert.equal((await closed).code, 4403);
  });

  it('subscribes, relays only the selected flights and ends when they all land', async () => {
    watchCalls = [];
    const c = await connect();
    await c.next('ready');
    c.send({ type: 'subscribe', icao24: ['AAAAA1', 'aaaaa2'] });

    const sub = await c.next('subscribed');
    assert.equal((sub['airline'] as { icao: string }).icao, 'AIC');
    assert.deepEqual(watchCalls[0]?.ids, ['aaaaa1', 'aaaaa2'], 'ids are normalised before calling tracking-service');
    assert.equal(watchCalls[0]?.headers['x-user-id'], 'subject-1');
    assert.equal(watchCalls[0]?.headers['x-internal-token'], 'internal-secret');
    assert.equal(bus.listeners('trk:pos:AIC'), 1);
    const event = published.at(-1);
    assert.equal(event?.['type'], 'track.start', 'a usage event is published for analytics');
    assert.equal(event?.['userId'], 'subject-1');
    assert.equal(event?.['airline'], 'AIC');
    assert.deepEqual(JSON.parse(event?.['callsigns'] ?? '[]'), ['AIC1', 'AIC1']);

    bus.publish('trk:pos:AIC', {
      airline: 'AIC', ts: 100, removed: [],
      flights: [{ icao24: 'aaaaa1', airlineIcao: 'AIC', lat: 1 }, { icao24: 'aaaaa9', airlineIcao: 'AIC', lat: 2 }],
    });
    const pos = await c.next('positions');
    assert.deepEqual((pos['flights'] as { icao24: string }[]).map((f) => f.icao24), ['aaaaa1'], 'other AIC flights are filtered out');

    bus.publish('trk:pos:AIC', { airline: 'AIC', ts: 101, flights: [], removed: ['aaaaa1', 'aaaaa2', 'aaaaa9'] });
    const gone = await c.next('positions');
    assert.deepEqual(gone['removed'], ['aaaaa1', 'aaaaa2']);
    await c.next('ended');
    assert.equal(bus.listeners('trk:pos:AIC'), 0, 'channel released after the last flight left');
    c.ws.close();
  });

  it('rejects more than 5 flights without calling tracking-service', async () => {
    watchCalls = [];
    const c = await connect();
    await c.next('ready');
    c.send({ type: 'subscribe', icao24: ['aaaaa1', 'aaaaa2', 'aaaaa3', 'aaaaa4', 'aaaaa5', 'aaaaa6'] });
    const err = await c.next('error');
    assert.equal(err['error'], 'invalid_selection');
    assert.equal(watchCalls.length, 0);
    c.ws.close();
  });

  it('forwards selection errors from tracking-service (mixed airlines)', async () => {
    const c = await connect();
    await c.next('ready');
    c.send({ type: 'subscribe', icao24: ['aaaaa1', 'bbbbb1'] });
    assert.equal((await c.next('error'))['error'], 'mixed_airlines');
    c.ws.close();
  });

  it('a new subscription replaces the previous one and closing releases it', async () => {
    const c = await connect();
    await c.next('ready');
    c.send({ type: 'subscribe', icao24: ['aaaaa1'] });
    await c.next('subscribed');
    c.send({ type: 'subscribe', icao24: ['bbbbb1', 'bbbbb2'] });
    await c.next('subscribed');
    assert.equal(bus.listeners('trk:pos:AIC'), 0);
    assert.equal(bus.listeners('trk:pos:BAW'), 1);

    c.ws.close();
    await c.closed;
    const started = Date.now();
    while (bus.listeners('trk:pos:BAW') > 0 && Date.now() - started < 2000) await new Promise((r) => setTimeout(r, 10));
    assert.equal(bus.listeners('trk:pos:BAW'), 0, 'subscription released when the client disconnects');
  });

  it('closes on invalid JSON with 4400', async () => {
    const c = await connect();
    await c.next('ready');
    c.ws.send('{not json');
    assert.equal((await c.closed).code, 4400);
  });
});
