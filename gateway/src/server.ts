import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import proxy from '@fastify/http-proxy';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { createAccessGuard } from './auth.js';
import type { GatewayConfig } from './config.js';
import { registerMetricsHooks } from './metrics.js';

/** Headers only the gateway may set — always stripped from client requests. */
const TRUSTED_HEADERS = ['x-internal-token', 'x-user-id', 'x-user-role'];

export async function buildServer(cfg: GatewayConfig, redis: Redis) {
  const app = Fastify({
    logger: { level: 'info' },
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
    allowList: (req) => req.url.startsWith('/health') || req.url === '/metrics',
  });
  registerMetricsHooks(app);

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

  // --- proxied API routes (from config/gateway.json) -----------------------------
  const guard = createAccessGuard(cfg);
  for (const route of cfg.routes) {
    await app.register(proxy, {
      upstream: route.target,
      prefix: route.prefix,
      rewritePrefix: route.prefix.replace(/^\/api/, ''),
      preHandler: guard(route.access),
      replyOptions: {
        rewriteRequestHeaders: (req, headers) => {
          const out: Record<string, string | string[] | undefined> = { ...headers };
          for (const h of TRUSTED_HEADERS) delete out[h];
          out['x-internal-token'] = cfg.internalToken;
          out['x-request-id'] = req.id;
          const principal = (req as FastifyRequest).principal;
          if (principal) {
            out['x-user-id'] = principal.sub;
            out['x-user-role'] = principal.role;
          }
          return out;
        },
      },
    });
    app.log.info({ prefix: route.prefix, target: route.target, access: route.access }, 'route registered');
  }

  return app;
}
