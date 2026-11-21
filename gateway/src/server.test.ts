import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { GatewayConfigSchema, type GatewayConfig } from './config.js';
import { buildServer } from './server.js';

const ISSUER = 'aerotrack-auth';
const USER_AUD = 'aerotrack-user';
const ADMIN_AUD = 'aerotrack-admin';
const CSRF = { 'x-requested-with': 'aerotrack' };

let upstream: Server;
let lastUpstream: { url: string; headers: IncomingHttpHeaders } | null = null;
/** Last request the fake upstream received (a function, so TS doesn't narrow it to null). */
const seen = () => lastUpstream;
let app: FastifyInstance;
let redis: Redis;
let privateKey: CryptoKey;

async function sign(aud: string, claims: Record<string, unknown> = {}, expiresIn = '5m') {
  return new SignJWT({ sid: 'sess-1', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(ISSUER)
    .setAudience(aud)
    .setSubject('subject-1')
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(privateKey);
}

before(async () => {
  upstream = createServer((req, res) => {
    lastUpstream = { url: req.url ?? '', headers: req.headers };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const keys = await generateKeyPair('RS256');
  privateKey = keys.privateKey;
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };

  const cfg: GatewayConfig = {
    ...GatewayConfigSchema.parse({
      env: 'test',
      listen: { host: '127.0.0.1', port: 8080 }, // never bound: tests use app.inject()
      cors: { origins: ['http://localhost:4200'], credentials: true },
      cookie: { secret: 'test-cookie-secret', secure: false, sameSite: 'lax', accessTokenName: 'aerotrack_at', adminAccessTokenName: 'aerotrack_admin_at' },
      jwt: { jwksUrl: 'http://127.0.0.1:1/jwks', issuer: ISSUER, userAudience: USER_AUD, adminAudience: ADMIN_AUD },
      redis: { host: '127.0.0.1', port: 6379, password: 'unused', db: 0 },
      internalToken: 'internal-secret',
      csrf: { header: 'x-requested-with', value: 'aerotrack' },
      rateLimit: { max: 1000, windowSeconds: 60 },
      websocket: { path: '/ws', maxFlightsPerClient: 5, sameAirlineOnly: true },
      routes: [
        { prefix: '/api/auth', target, access: 'public' },
        { prefix: '/api/airlines', target, access: 'user' },
        { prefix: '/api/admin/account', target, access: 'admin', allowPendingPasswordChange: true },
        { prefix: '/api/admin', target, access: 'admin' },
      ],
    }),
    path: 'test',
  };

  // No Redis in unit tests: commands fail fast and the rate limiter skips on error.
  redis = new Redis({ host: '127.0.0.1', port: 1, lazyConnect: true, enableOfflineQueue: false, retryStrategy: () => null });
  redis.on('error', () => {});
  app = await buildServer(cfg, redis, { keySet: createLocalJWKSet({ keys: [jwk] }), logger: false });
});

after(async () => {
  await app?.close();
  redis?.disconnect();
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
});

describe('access guard', () => {
  it('rejects protected routes without credentials', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/airlines' });
    assert.equal(res.statusCode, 401);
  });

  it('proxies a valid user token and sets trusted identity headers', async () => {
    const token = await sign(USER_AUD);
    lastUpstream = null;
    const res = await app.inject({
      method: 'GET',
      url: '/api/airlines/AIC',
      headers: { authorization: `Bearer ${token}`, 'x-user-role': 'admin', 'x-internal-token': 'spoofed' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(seen()?.url, '/airlines/AIC', 'the /api prefix is stripped');
    assert.equal(seen()?.headers['x-user-id'], 'subject-1');
    assert.equal(seen()?.headers['x-user-role'], 'user', 'spoofed role header must be replaced');
    assert.equal(seen()?.headers['x-session-id'], 'sess-1');
    assert.equal(seen()?.headers['x-internal-token'], 'internal-secret');
  });

  it('accepts the access token from the httpOnly cookie', async () => {
    const token = await sign(USER_AUD);
    const res = await app.inject({ method: 'GET', url: '/api/airlines', cookies: { aerotrack_at: token } });
    assert.equal(res.statusCode, 200);
  });

  it('never accepts a user token on admin routes', async () => {
    const token = await sign(USER_AUD);
    const res = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 401);
  });

  it('rejects expired tokens', async () => {
    const token = await sign(USER_AUD, {}, '-1m');
    const res = await app.inject({ method: 'GET', url: '/api/airlines', headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 401);
  });

  it('limits admins with a pending password change to the account routes', async () => {
    const token = await sign(ADMIN_AUD, { mcp: true });
    const blocked = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { authorization: `Bearer ${token}` } });
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.json().error, 'password_change_required');

    const allowed = await app.inject({ method: 'GET', url: '/api/admin/account/me', headers: { authorization: `Bearer ${token}` } });
    assert.equal(allowed.statusCode, 200);
    assert.equal(seen()?.url, '/admin/account/me');
  });

  it('lets a fully signed-in admin reach admin routes', async () => {
    const token = await sign(ADMIN_AUD);
    const res = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 200);
    assert.equal(seen()?.headers['x-user-role'], 'admin');
  });
});

describe('csrf protection', () => {
  it('rejects mutating API requests without the CSRF header', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/refresh' });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'csrf');
  });

  it('allows mutating API requests that carry the CSRF header', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: CSRF });
    assert.equal(res.statusCode, 200);
  });

  it('does not require the header for safe methods', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/github/login' });
    assert.equal(res.statusCode, 200);
  });
});
