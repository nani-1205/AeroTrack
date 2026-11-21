#!/usr/bin/env node
// Derives the docker-compose .env from config/services.json, so that JSON file stays
// the single source of truth for infrastructure credentials. Safe to run repeatedly.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function syncComposeEnv() {
  const servicesPath = path.join(root, 'config', 'services.json');
  if (!existsSync(servicesPath)) {
    console.error('✘ config/services.json not found — run `npm run setup` first');
    process.exit(1);
  }
  const s = JSON.parse(readFileSync(servicesPath, 'utf8'));
  const vars = {
    POSTGRES_SUPERUSER: s.infra.postgresSuperuser,
    POSTGRES_SUPERUSER_PASSWORD: s.infra.postgresSuperuserPassword,
    POSTGRES_DB: s.shared.postgres.database,
    POSTGRES_PORT: s.shared.postgres.port,
    REDIS_PORT: s.shared.redis.port,
    REDIS_PASSWORD: s.shared.redis.password,
    AUTH_DB_SCHEMA: s.auth.db.schema,
    AUTH_DB_USER: s.auth.db.user,
    AUTH_DB_PASSWORD: s.auth.db.password,
    TRACKING_DB_SCHEMA: s.tracking.db.schema,
    TRACKING_DB_USER: s.tracking.db.user,
    TRACKING_DB_PASSWORD: s.tracking.db.password,
    ANALYTICS_DB_SCHEMA: s.analytics.db.schema,
    ANALYTICS_DB_USER: s.analytics.db.user,
    ANALYTICS_DB_PASSWORD: s.analytics.db.password,
  };

  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined || value === null || value === '' || value === 'CHANGE_ME') {
      console.error(`✘ ${key} is missing or still CHANGE_ME in config/services.json`);
      process.exit(1);
    }
    if (/[\s$"'`\\]/.test(String(value))) {
      console.error(`✘ ${key} contains whitespace, quotes, $ or \\ — not supported in compose .env`);
      process.exit(1);
    }
  }

  const body = [
    '# GENERATED from config/services.json by scripts/sync-compose-env.mjs — DO NOT EDIT.',
    ...Object.entries(vars).map(([k, v]) => `${k}=${v}`),
    '',
  ].join('\n');
  writeFileSync(path.join(root, '.env'), body, { mode: 0o600 });
  console.log('✔ synced .env for docker-compose from config/services.json');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) syncComposeEnv();
