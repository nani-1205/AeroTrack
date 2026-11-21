# AeroTrack

Live aircraft and air-traffic tracking, built as microservices.

| Part | Stack | Port | Path |
|---|---|---|---|
| User portal (GitHub SSO) | Angular 22 | 4200 | [frontend/projects/user-portal](frontend/projects/user-portal) |
| Admin portal (username + password) | Angular 22 | 4201 | [frontend/projects/admin-portal](frontend/projects/admin-portal) |
| Shared UI/core library | Angular | — | [frontend/projects/shared](frontend/projects/shared) |
| API gateway | Node.js, Fastify, TypeScript | 8080 | [gateway](gateway) |
| auth-service | Go | 7001 | [services/auth-service](services/auth-service) |
| tracking-service | Rust (axum, sqlx) | 7002 | [services/tracking-service](services/tracking-service) |
| analytics-service | Ruby (Rails 8.1 API) | 7003 | [services/analytics-service](services/analytics-service) |
| PostgreSQL 18, Redis 8, Prometheus | docker-compose | 5432 / 6379 / 9090 | [docker-compose.yml](docker-compose.yml) |

Flight data comes only from free, open sources: **OpenSky Network** (primary), **adsb.lol** (fallback), and a built-in **simulator** for offline development.

## Prerequisites

Docker (with Compose), Node 22+, Go 1.25+, Rust 1.85+, and Ruby 3.3+ with Bundler.

## First-time setup

```sh
npm run setup        # creates config/services.json + config/gateway.json with random secrets,
                     # JWT keys in config/keys/, and the docker-compose .env
npm run infra:up     # Postgres 18 + Redis 8 + Prometheus (waits until healthy)

npm --prefix gateway install
npm --prefix frontend install
(cd services/analytics-service && bundle config set --local path vendor/bundle && bundle install)
```

`npm run setup` never overwrites existing files. It prints the bootstrap admin password once, and that password is also stored in `config/services.json` under `auth.admin`.

## Running (one terminal each)

```sh
npm run dev:auth          # Go
npm run dev:tracking      # Rust
npm run dev:analytics     # Ruby
npm run dev:gateway       # Node
npm run dev:user-portal   # http://localhost:4200
npm run dev:admin-portal  # http://localhost:4201
```

Every service exposes `GET /health/live`, `GET /health/ready` (checks Postgres and Redis) and `GET /metrics`. While not in production, the gateway also serves `GET /health/services`, which aggregates all upstream services. Both portals show it on their home page.

## Configuration: two JSON files

All secrets and service-to-service call settings live in **two files**. Both are git-ignored, and their `*.example.json` templates are committed:

| File | Read by | Contains |
|---|---|---|
| [config/services.json](config/services.example.json) | auth, tracking, analytics (each reads `shared` plus its own section) and docker-compose (through the generated `.env`) | DB and Redis credentials, JWT settings, the internal token, GitHub OAuth app, admin bootstrap account, OpenSky / adsb.lol / Prometheus URLs |
| [config/gateway.json](config/gateway.example.json) | gateway only | the routing table (`prefix` → `target` + `access`), CORS, cookies, JWKS URL, rate limits, WebSocket limits |

- Override the file location with `AEROTRACK_CONFIG` (services) or `GATEWAY_CONFIG` (gateway), for example to use a Docker secret mount.
- Every service validates its config at startup. A missing value or a leftover `CHANGE_ME` stops it.
- Relative paths inside `services.json`, such as JWT key paths, resolve against the `config/` directory.
- `.env` is **generated** by `scripts/sync-compose-env.mjs`, and `npm run infra:up` re-syncs it. Never edit it by hand.
- The Angular apps contain no secrets. In development, `/api`, `/health` and `/ws` are proxied to the gateway through [frontend/proxy.conf.json](frontend/proxy.conf.json).

## Database and migration policy

- There is one Postgres database, with **one schema and one login role per service** (`auth`, `tracking`, `analytics`). These are created by [infra/postgres/init](infra/postgres/init) the first time the volume is initialised.
- **Every service migrates its own schema at startup**:
  1. it waits for Postgres, retrying with backoff (`shared.postgres.startupRetries`);
  2. it takes a Postgres **advisory lock**, so replicas never migrate concurrently;
  3. it applies **only pending** migrations, forward-only.
- **Nothing is ever forced.** There is no reset, no drop and no "force version". If an applied migration was edited (checksum mismatch), is missing, or was only partly applied, the service **refuses to start** with a clear error.
- To change a schema, **add a new migration file**. Never edit an applied one.

| Service | Tool | Migrations |
|---|---|---|
| auth | goose (embedded SQL) | [services/auth-service/internal/database/migrations](services/auth-service/internal/database/migrations) |
| tracking | sqlx `migrate!` (embedded) | [services/tracking-service/migrations](services/tracking-service/migrations) |
| analytics | ActiveRecord | [services/analytics-service/db/migrate](services/analytics-service/db/migrate) |

> The init script runs only on an **empty** volume. If you change DB passwords in `services.json` after the first run, either `ALTER ROLE` them yourself or, to discard all local data, run `docker compose down -v`.

## Gateway security model

- JWTs are verified against the auth-service JWKS (RS256). **User and admin tokens have different audiences**, so a user token can never open `/api/admin/*`.
- Client-supplied `x-user-id`, `x-user-role` and `x-internal-token` headers are always stripped. The gateway sets them itself after verification, and services trust only requests that carry the internal token.
- Rate limiting is shared through Redis, and requests still go through if Redis is briefly unavailable.

## Roadmap

- [x] **Phase 0**: scaffold, config files, docker-compose, startup migrations, health checks and metrics everywhere
- [ ] **Phase 1**: auth (GitHub SSO users, admin username/password with argon2id and lockout, JWT/JWKS, refresh sessions)
- [ ] **Phase 2**: tracking backend (airline seed data, OpenSky / adsb.lol / simulator providers, Redis live state, pub/sub)
- [ ] **Phase 3**: user portal (airlines → active flights → live map, 1–5 flights of the same airline, WebSocket)
- [ ] **Phase 4**: analytics service and admin dashboard (signed-in users, usage, system performance)
- [ ] **Phase 5**: tests, Dockerfiles, CI, hardening
