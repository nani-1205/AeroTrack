# Runbook: infrastructure (PostgreSQL, Redis, Prometheus)

Local development infrastructure runs in Docker Compose ([docker-compose.yml](../../docker-compose.yml)). The application services run on the host and connect to it.

| Container | Image | Host port | Data volume | Purpose |
|---|---|---|---|---|
| `postgres` | `postgres:18-alpine` | 5432 | `pgdata` | One database `aerotrack`, one schema + role per service |
| `redis` | `redis:8-alpine` (password, AOF on) | 6379 | `redisdata` | Sessions, live flight state, pub/sub, event streams, rate limits |
| `prometheus` | `prom/prometheus:v3.5.0` | 9090 | `promdata` | Scrapes `/metrics` of all four services every 15 s |

## Configuration

Compose reads credentials from **`.env`**. That file is **generated** from `config/services.json` by [scripts/sync-compose-env.mjs](../../scripts/sync-compose-env.mjs), which `npm run setup` and `npm run infra:up` both run. **Never edit `.env` by hand.**

| `services.json` key | Becomes | Used for |
|---|---|---|
| `infra.postgresSuperuser` / `infra.postgresSuperuserPassword` | `POSTGRES_SUPERUSER` / `POSTGRES_SUPERUSER_PASSWORD` | Postgres superuser (administration only; no service uses it) |
| `shared.postgres.database`, `.port` | `POSTGRES_DB`, `POSTGRES_PORT` | Database name and published port |
| `shared.redis.password`, `.port` | `REDIS_PASSWORD`, `REDIS_PORT` | Redis `requirepass` and published port |
| `<service>.db.user` / `.password` / `.schema` | `AUTH_DB_*`, `TRACKING_DB_*`, `ANALYTICS_DB_*` | Per-service roles and schemas, created on first init |

- **Per-service roles and schemas** are created by [infra/postgres/init/01-service-roles.sh](../../infra/postgres/init/01-service-roles.sh). It runs **only when the volume is empty** (the first start). It also revokes `CONNECT` and `public`-schema access from `PUBLIC`.
- **Prometheus scrape targets** are set in [infra/prometheus/prometheus.yml](../../infra/prometheus/prometheus.yml). They point at `host.docker.internal:{8080,7001,7002,7003}`, because the services run on the host.

## Run

```sh
npm run setup        # first time only: generates config/*.json, JWT keys and .env
npm run infra:up     # re-syncs .env, starts the containers, waits until healthy
npm run infra:logs   # follow the container logs
npm run infra:down   # stop (data volumes are kept)
docker compose ps    # status and health
```

**On Linux** the same commands work with Docker Engine and the Compose plugin. Prometheus reaches services running on the host through `host.docker.internal`, which the compose file maps to the host gateway. If a firewall (e.g. `ufw`) is active, allow the Docker bridge to reach ports 7001–7003 and 8080, or the Prometheus targets show DOWN.

## Everyday commands

```sh
# SQL shell as the superuser
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
#   \dn                     list schemas (auth, tracking, analytics)
#   \dt auth.*              tables in a schema
#   SELECT * FROM auth.goose_db_version;            auth migrations
#   SELECT * FROM tracking._sqlx_migrations;        tracking migrations
#   SELECT * FROM analytics.schema_migrations;      analytics migrations

# Redis shell
docker compose exec redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning'
#   SCAN 0 MATCH trk:* COUNT 100     live tracking keys
#   XLEN events:auth                 analytics event stream length
#   INFO memory

# Prometheus UI
open http://localhost:9090/targets   # all four jobs should be UP while the services run
```

## Redis key map

The detail for each key family is in the runbook of the service that owns it.

| Prefix / key | Owner | Contents |
|---|---|---|
| `auth:*` | auth-service | Refresh sessions, active-session sets, OAuth `state` values |
| `trk:*` | tracking-service | Live flights, airline sets and counts, trails, watched flights, ingest leader lock |
| `trk:pos:{ICAO}` (pub/sub channel) | tracking → gateway | Live position batches per airline |
| `events:auth`, `events:tracking` (streams) | auth / gateway → analytics | Usage events, consumed by the `analytics` consumer group |
| `gw:ratelimit:*` | gateway | Rate-limit counters |
| Redis DB **15** | tests | Used by the Go and Rust integration tests, and flushed by them. Never store real data there. |

## Routine tasks

**Back up and restore the database**

```sh
docker compose exec postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > aerotrack.dump
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < aerotrack.dump
```

**Change a database password after the first init.** The init script won't run again, so change it in both places:
1. Run `ALTER ROLE auth_svc PASSWORD '<new>';` as the superuser.
2. Update `auth.db.password` in `services.json`.
3. Restart the service.

**Start from scratch (DESTROYS ALL LOCAL DATA)**

```sh
docker compose down -v      # removes pgdata, redisdata, promdata
npm run infra:up            # re-creates roles/schemas; services re-run migrations on start
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `✘ config/services.json not found` from `infra:up` | Setup has not been run | `npm run setup` |
| A service logs `password authentication failed for user "auth_svc"` | The password in `services.json` was changed after the volume was created | `ALTER ROLE …` (above), or `docker compose down -v` to start over |
| `relation … does not exist` / `permission denied for schema` | The volume was created before the init script existed, or by another project | `docker compose down -v`, then `npm run infra:up` |
| Port 5432, 6379 or 9090 already in use | Another local Postgres, Redis or Prometheus | Stop the other one, or change the port in `services.json` (`shared.postgres.port`, `shared.redis.port`) and run `npm run infra:up` |
| Prometheus targets DOWN | The services aren't running, or a firewall blocks Docker → host | Start the services; allow the ports through Windows Defender Firewall |
| `NOAUTH Authentication required` in a Redis client | No password given | Use the `redis-cli -a "$REDIS_PASSWORD"` form above |
