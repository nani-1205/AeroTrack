import { Redis } from 'ioredis';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

async function main() {
  const cfg = loadConfig();

  const redis = new Redis({
    host: cfg.redis.host,
    port: cfg.redis.port,
    password: cfg.redis.password,
    db: cfg.redis.db,
    maxRetriesPerRequest: 2,
    connectionName: 'gateway',
  });
  redis.on('error', (err) => console.error(JSON.stringify({ level: 'error', msg: 'redis error', err: err.message })));

  const app = await buildServer(cfg, redis);
  app.log.info({ path: cfg.path, env: cfg.env }, 'config loaded');

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await redis.quit();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: cfg.listen.host, port: cfg.listen.port });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
