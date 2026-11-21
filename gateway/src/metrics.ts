import type { FastifyInstance } from 'fastify';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
registry.setDefaultLabels({ service: 'gateway' });
collectDefaultMetrics({ register: registry });

const requests = new Counter({
  name: 'http_requests_total',
  help: 'HTTP requests handled, by route and status.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

const duration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency, by route.',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

/** Records metrics per route template (never raw URLs → bounded label cardinality). */
export function registerMetricsHooks(app: FastifyInstance) {
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    requests.inc({ method: req.method, route, status: String(reply.statusCode) });
    duration.observe({ method: req.method, route }, reply.elapsedTime / 1000);
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });
}
