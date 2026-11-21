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

After pulling a new phase, run `npm run config:migrate`. It adds any new config keys from the templates to your local `services.json` and `gateway.json` and leaves your existing values and secrets alone.

**GitHub SSO:** create an OAuth App under GitHub → Settings → Developer settings → OAuth Apps.
- Homepage URL: `http://localhost:4200`
- Authorization callback URL: `http://localhost:8080/api/auth/github/callback`

Put its client ID and secret in `config/services.json` → `auth.github`.

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

## Authentication

| | User portal | Admin portal |
|---|---|---|
| Sign-in | GitHub OAuth (`GET /api/auth/github/login`) | Username and password (`POST /api/admin/auth/login`) |
| Account store | `auth.users` (upserted from the GitHub profile) | `auth.admins` (argon2id hashes) |
| Cookies (httpOnly) | `aerotrack_at` (access), `aerotrack_rt` (refresh, path `/api/auth`) | `aerotrack_admin_at`, `aerotrack_admin_rt` (path `/api/admin/auth`) |
| JWT audience | `aerotrack-user` | `aerotrack-admin` |
| Self-service | `GET /api/account/me` | `GET /api/admin/account/me`, `POST /api/admin/account/password` |

- **Tokens:** access tokens are RS256 JWTs with a 15-minute lifetime. The gateway verifies them against `GET /.well-known/jwks.json` on the auth-service.
- **Refresh tokens:** these are opaque random strings stored only as SHA-256 hashes in Redis. They **rotate** on every `POST …/refresh`, with a 30-second grace window so two tabs refreshing at once don't log each other out. Logout revokes the session.
- **GitHub flow:** a single-use `state` is stored in Redis and also bound to the browser by a short-lived cookie, which protects against login CSRF. If the profile email is hidden, the primary verified email is used instead.
- **Admin accounts:**
  - The first admin is created from `auth.admin.bootstrap*`, and only when no admin exists. It must **change its password on first sign-in**; until then the gateway allows that token only on `/api/admin/account/*`.
  - After `maxFailedAttempts` failures the account is locked for `lockoutMinutes`.
  - Unknown usernames and wrong passwords return the same response and take the same time.
  - Changing the password signs out all other sessions of that admin.
- **Auditing and analytics:** every login attempt is written to `auth.login_events` and published to the Redis stream `events:auth`, which feeds analytics in Phase 4. Prometheus gets `auth_logins_total{kind,result}` and `auth_active_sessions{kind}`.

## Live tracking (tracking-service)

**Data sources** (all free and open). Set them in `services.json` → `tracking`:

| Setting | Options | Role |
|---|---|---|
| `provider` | `simulator` (default for development), `opensky` | **Global feed.** Decides which flights are active. OpenSky returns every airborne aircraft worldwide in one call. |
| `watchProvider` | `adsbLol`, `none` | **Fast refresh** of flights users are watching (every `adsbLol.pollIntervalSeconds`, 5 s by default). Adds registration and aircraft type. Only used with `opensky`. |

- **OpenSky budget:** a global poll costs 4 API credits.
  - Without credentials you get about 400 credits a day, so use `pollIntervalSeconds` ≥ 900.
  - With a free account (`clientId`/`clientSecret`) you get about 4,000 a day, so use ≥ 90.
  - The service warns at startup when the interval would exceed the budget, and backs off on HTTP 429.
- **Matching flights to airlines:** flights are matched by the callsign's ICAO prefix (`UAL1003` belongs to `UAL`). Registrations such as `N123AB` and flights on the ground are ignored.
- **Catalogue:** the airline catalogue (5,774 airlines) is seeded at startup from OpenFlights data. © OpenFlights contributors, ODbL 1.0; see [seed/README.md](services/tracking-service/seed/README.md).

**API.** The gateway routes these as `/api/...`; all of them require a signed-in user.

| Endpoint | Returns |
|---|---|
| `GET /api/airlines?limit=100` | Airlines that have active flights, busiest first, with `activeFlights` |
| `GET /api/airlines?search=air india` | Catalogue search by ICAO, IATA or name. Best match first; among equal matches, airlines with live flights first. |
| `GET /api/airlines/{icao}` | One airline with its live count |
| `GET /api/airlines/{icao}/flights` | Active flights of that airline, sorted by callsign |
| `GET /api/flights/{icao24}?trail=true` | One flight, its airline, and the trail `[[lat, lon, altM, unixS], …]` |
| `POST /api/flights/watch` `{"icao24": [...]}` | Validates **1–5 flights of one airline**. Returns 422 `invalid_selection` / `mixed_airlines` or 404 `not_active`. Marks the flights as watched for `watchTtlSeconds` and returns their current state. |

All values are in SI units: metres, m/s and degrees.

**Redis keys.** The gateway reads these in Phase 3:
- `trk:f:{icao24}`: flight JSON, with a TTL of `staleAfterSeconds`
- `trk:a:{ICAO}`: active flights of an airline
- `trk:counts`: active-flight count per airline
- `trk:t:{icao24}`: trail
- `trk:watch`: watched flights
- pub/sub `trk:pos:{ICAO}`: `{airline, ts, flights[], removed[]}` after every update

**Scaling:** only the instance holding the Redis lock `trk:ingest:leader` ingests data, so any number of replicas can serve the API.

## User portal: from airline to live map

1. **Airlines** (`/`): airlines with flights in the air, busiest first, refreshed every 30 s. You can search by name, ICAO or IATA code.
2. **Active flights** (`/airlines/{ICAO}`): a table of the airline's airborne flights showing route, altitude, speed, heading, aircraft and time airborne, refreshed every 20 s.
   - Tick **up to 5** flights; the other checkboxes lock once 5 are picked.
   - Then choose **Track live**, or use the row's **Track** button for a single flight.
3. **Live tracking** (`/track?ids=…`):
   - A MapLibre map with an OpenFreeMap basemap (free, OpenStreetMap data, no API key).
   - One colour per flight, with the plane icon rotated to its heading and a trail.
   - Between updates, aircraft are moved forward along their heading at their speed (at most 120 s ahead), so the map stays smooth even on a 90 s OpenSky feed.
   - The side panel shows altitude, speed, heading, climb rate, aircraft/registration, time airborne and last update.
   - When a flight lands it is marked *no longer reported*.

**Live WebSocket** (`/ws` on the gateway; the dev server proxies it):

| Direction | Frame |
|---|---|
| client → gateway | `{type:"subscribe", icao24:[1–5 ids]}`, `{type:"unsubscribe"}`, `{type:"ping"}` |
| gateway → client | `ready`, `subscribed {airline, flights, watchTtlSeconds}`, `positions {ts, flights, removed}`, `ended`, `error {error, message}`, `pong` |

- **Authentication:** the user's access cookie, plus an `Origin` check against `cors.origins`.
- **Validation:** selections go through tracking-service `POST /flights/watch` (1–5 flights, one airline). That call is repeated every `watchTtlSeconds/2` while subscribed.
- **Delivery:** only the subscribed flights are relayed from `trk:pos:{ICAO}`.
- **Close codes:** `4401` means unauthenticated or the token expired; the client refreshes its session and reconnects automatically. `4403` means a foreign origin, `4400` a bad frame, `4429` too many messages.
- **Reconnecting:** after network drops the client reconnects with backoff (1 s → 30 s) and re-subscribes.

## Gateway security model

- JWTs are verified against the auth-service JWKS (RS256). **User and admin tokens have different audiences**, so a user token can never open `/api/admin/*`.
- Client-supplied `x-user-id`, `x-user-role`, `x-session-id`, `x-forwarded-for` and `x-internal-token` headers are always stripped. The gateway sets them itself after verification, and services trust only requests that carry the internal token.
- **CSRF:** every mutating `/api` request must send `X-Requested-With: aerotrack` (set in `csrf` in `gateway.json`). A custom header forces a CORS preflight, which only the portal origins pass. Cookies are also `SameSite=Lax`.
- Rate limiting is shared through Redis, and requests still go through if Redis is briefly unavailable.

## Tests

```sh
(cd services/auth-service && go test ./...)   # unit + integration (needs `npm run infra:up`; uses Redis DB 15, cleans up its rows)
(cd services/tracking-service && cargo test)  # geo, parsers, simulator, selection rules + API/live-store integration (Redis DB 15)
npm --prefix gateway test                     # access guard, audiences, CSRF, trusted headers, live WebSocket (real sockets)
npm --prefix frontend run test:all            # interceptors, both portals, flight selection (max 5), live socket client, formatting, dead reckoning
```

## Roadmap

- [x] **Phase 0**: scaffold, config files, docker-compose, startup migrations, health checks and metrics everywhere
- [x] **Phase 1**: auth (GitHub SSO users, admin username/password with argon2id and lockout, JWT/JWKS, refresh sessions)
- [x] **Phase 2**: tracking backend (airline seed data, OpenSky / adsb.lol / simulator providers, Redis live state, pub/sub)
- [x] **Phase 3**: user portal (airlines → active flights → live map, 1–5 flights of the same airline, WebSocket)
- [ ] **Phase 4**: analytics service and admin dashboard (signed-in users, usage, system performance)
- [ ] **Phase 5**: tests, Dockerfiles, CI, hardening
