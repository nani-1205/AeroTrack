import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import proxy from '@fastify/http-proxy';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import type { JWTVerifyGetKey } from 'jose';
import { createAccessGuard, createTokenVerifier } from './auth.js';
import type { GatewayConfig } from './config.js';
import { type PositionBus, RedisPositionBus } from './live/bus.js';
import { type TrackingEvents, registerLiveSocket } from './live/socket.js';

/** Contract with analytics-service. */
export const TRACKING_EVENTS_STREAM = 'events:tracking';
import { registerMetricsHooks } from './metrics.js';

/** Headers only the gateway may set — always stripped from client requests. */
const TRUSTED_HEADERS = ['x-internal-token', 'x-user-id', 'x-user-role', 'x-session-id', 'x-forwarded-for'];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface BuildOptions {
  /** Override JWKS lookup (tests). Defaults to the auth-service JWKS URL from config. */
  keySet?: JWTVerifyGetKey;
  /** Override the live position bus (tests). Defaults to Redis pub/sub on a dedicated connection. */
  bus?: PositionBus;
  /** Override the analytics event sink (tests). Defaults to the Redis stream `events:tracking`. */
  events?: TrackingEvents;
  logger?: boolean;
}

export async function buildServer(cfg: GatewayConfig, redis: Redis, opts: BuildOptions = {}) {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: 'info' },
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
  });

  app.decorateRequest('principal', null);

  await app.register(cors, { origin: cfg.cors.origins, credentials: cfg.cors.credentials });
  await app.register(cookie, { secret: cfg.cookie.secret });
  await app.register(rateLimit, {
    max: cfg.rateLimit.max,
    timeWindow: cfg.rateLimit.windowSeconds * 1000,
    redis,
    nameSpace: 'gw:ratelimit:',
    skipOnError: true, // never take the API down because Redis blipped
    keyGenerator: (req) => req.ip ?? 'unknown', // injected/odd requests may lack a socket address
    allowList: (req) => req.url.startsWith('/health') || req.url === '/metrics',
  });
  registerMetricsHooks(app);

  // CSRF: browsers cannot add a custom header cross-origin without a CORS preflight,
  // which only our portal origins pass. Applies to every mutating API call.
  app.addHook('onRequest', async (req, reply) => {
    if (SAFE_METHODS.has(req.method) || !req.url.startsWith('/api/')) return;
    if (req.headers[cfg.csrf.header] !== cfg.csrf.value) {
      return reply.code(403).send({ error: 'csrf', message: `missing ${cfg.csrf.header} header` });
    }
  });

  // --- health -----------------------------------------------------------------
  app.get('/health/live', async () => ({ status: 'ok', service: 'gateway' }));

  app.get('/health/ready', async (_req, reply) => {
    const redisStatus = await redis.ping().then(() => 'ok', (err: Error) => err.message);
    return reply.code(redisStatus === 'ok' ? 200 : 503).send({ service: 'gateway', checks: { redis: redisStatus } });
  });

  // Aggregated upstream status — development aid only (admin portal gets this via analytics later).
  if (cfg.env !== 'production') {
    const targets = [...new Set(cfg.routes.map((r) => r.target))];
    app.get('/health/services', async () => {
      const entries = await Promise.all(
        targets.map(async (target) => {
          try {
            const res = await fetch(`${target}/health/ready`, { signal: AbortSignal.timeout(2_000) });
            return [target, { status: res.status, body: await res.json() }] as const;
          } catch (err) {
            return [target, { status: 0, error: (err as Error).message }] as const;
          }
        }),
      );
      return Object.fromEntries(entries);
    });
  }

  const verifier = createTokenVerifier(cfg, opts.keySet);

  // --- live tracking WebSocket ---------------------------------------------------
  let bus = opts.bus;
  if (!bus) {
    const subscriber = redis.duplicate({ connectionName: 'gateway-live' });
    subscriber.on('error', (err: Error) => app.log.error({ err }, 'live position subscriber error'));
    app.addHook('onClose', async () => void (await subscriber.quit().catch(() => undefined)));
    bus = new RedisPositionBus(subscriber);
  }
  const events: TrackingEvents = opts.events ?? {
    publish: (fields) => {
      redis
        .xadd(TRACKING_EVENTS_STREAM, 'MAXLEN', '~', '100000', '*', ...Object.entries(fields).flat())
        .catch((err: Error) => app.log.warn({ err }, 'publish tracking event failed'));
    },
  };
  await app.register(websocket, { options: { maxPayload: 4 * 1024 } });
  registerLiveSocket(app, { cfg, verifier, bus, events });

  // --- proxied API routes (from config/gateway.json) -----------------------------
  const guard = createAccessGuard(verifier);
  for (const route of cfg.routes) {
    await app.register(proxy, {
      upstream: route.target,
      prefix: route.prefix,
      rewritePrefix: route.prefix.replace(/^\/api/, ''),
      preHandler: guard(route),
      replyOptions: {
        // An unreachable upstream is "service unavailable" (503) or a timeout (504) — not a
        // gateway bug (the library's default answers 500 for e.g. ECONNREFUSED).
        onError: (reply, { error }) => {
          const timeout = (error as { statusCode?: number }).statusCode === 504;
          reply.log.warn({ err: error, upstream: route.target }, 'upstream unavailable');
          void reply
            .code(timeout ? 504 : 503)
            .send({ error: timeout ? 'timeout' : 'unavailable', message: 'This service is temporarily unavailable. Please try again shortly.' });
        },
        rewriteRequestHeaders: (req, headers) => {
          const request = req as FastifyRequest;
          const out: Record<string, string | string[] | undefined> = { ...headers };
          for (const h of TRUSTED_HEADERS) delete out[h];
          out['x-internal-token'] = cfg.internalToken;
          out['x-request-id'] = request.id;
          out['x-forwarded-for'] = request.ip;
          const principal = request.principal;
          if (principal) {
            out['x-user-id'] = principal.sub;
            out['x-user-role'] = principal.role;
            out['x-session-id'] = principal.sessionId;
          }
          return out;
        },
      },
    });
    app.log.info({ prefix: route.prefix, target: route.target, access: route.access }, 'route registered');
  }

  return app;
}
