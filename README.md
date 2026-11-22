# AeroTrack

Live aircraft and air-traffic tracking, built as microservices.

- **Users** sign in with GitHub, pick an airline, select 1–5 of its flights in the air, and follow them live on a map, with routes, trails and telemetry.
- **Admins** use a separate console, with username and password sign-in, to see who is signed in, how the product is used, and how every service is performing.

Flight data comes only from **free, open sources**:
- **OpenSky Network:** worldwide positions;
- **adsb.lol:** fast refresh of the flights users are watching;
- a built-in **simulator**, used by default for offline development.

## Architecture

```
            ┌──────────────────────┐        ┌──────────────────────┐
            │  User portal  :4200  │        │  Admin console :4201 │   Angular 22
            └──────────┬───────────┘        └──────────┬───────────┘
                       │   /api · /ws (live positions) · /health
                       ▼                               ▼
            ┌─────────────────────────────────────────────────────┐
            │  API gateway :8080   Node.js · Fastify · TypeScript │  JWT (RS256/JWKS), CSRF,
            └──────┬──────────────────┬──────────────────┬────────┘  rate limits, WebSocket
                   ▼                  ▼                  ▼
            auth-service :7001  tracking-service :7002  analytics-service :7003
            Go                  Rust                    Ruby on Rails
            GitHub SSO, admins, OpenSky / adsb.lol /    usage events, user stats,
            JWT, sessions       simulator, live state   Prometheus metrics
                   └──────────────────┼──────────────────┘
                PostgreSQL 18 (one schema per service) · Redis 8 · Prometheus
```

| Component | Stack | Port | Runbook |
|---|---|---|---|
| User portal | Angular 22, MapLibre GL | 4200 | [docs/runbooks/user-portal.md](docs/runbooks/user-portal.md) |
| Admin console | Angular 22, SVG charts | 4201 | [docs/runbooks/admin-portal.md](docs/runbooks/admin-portal.md) |
| API gateway | Node.js 22+, Fastify 5, TypeScript | 8080 | [docs/runbooks/gateway.md](docs/runbooks/gateway.md) |
| auth-service | Go 1.25+ | 7001 | [docs/runbooks/auth-service.md](docs/runbooks/auth-service.md) |
| tracking-service | Rust (axum, sqlx) | 7002 | [docs/runbooks/tracking-service.md](docs/runbooks/tracking-service.md) |
| analytics-service | Ruby on Rails 8.1 (API) | 7003 | [docs/runbooks/analytics-service.md](docs/runbooks/analytics-service.md) |
| PostgreSQL 18 · Redis 8 · Prometheus | Docker Compose | 5432 · 6379 · 9090 | [docs/runbooks/infrastructure.md](docs/runbooks/infrastructure.md) |

The [runbooks index](docs/runbooks/README.md) lists the conventions every service shares: config, health, metrics, migrations, logs.

## Quick start

**Prerequisites:** Docker with Compose, Node.js 22+, Go 1.25+, Rust 1.85+, Ruby 3.3+ with Bundler.

```sh
# 1. Configuration, secrets, JWT keys (never overwrites existing files)
npm run setup

# 2. Infrastructure: PostgreSQL, Redis, Prometheus
npm run infra:up

# 3. Dependencies
npm --prefix gateway install
npm --prefix frontend install
(cd services/analytics-service && bundle config set --local path vendor/bundle && bundle install)
```

**4. GitHub sign-in.** Create an OAuth App under GitHub → Settings → Developer settings → OAuth Apps:
- Homepage URL: `http://localhost:4200`
- Callback URL: `http://localhost:8080/api/auth/github/callback`

Copy its client ID and secret into `config/services.json` → `auth.github`.

**5. Run each service in its own terminal:**

```sh
npm run dev:auth           # Go        :7001
npm run dev:tracking       # Rust      :7002
npm run dev:analytics      # Ruby      :7003
npm run dev:gateway        # Node      :8080
npm run dev:user-portal    # http://localhost:4200
npm run dev:admin-portal   # http://localhost:4201
```

**6. Open the portals.**
- **User portal**, http://localhost:4200: sign in with GitHub.
- **Admin console**, http://localhost:4201: sign in as `admin` with `auth.admin.bootstrapPassword` from `config/services.json`. You'll be asked to choose a new password.

To check everything is up, open http://localhost:8080/health/services. It returns the readiness of every backend service.

## Building for Linux (production)

One script builds every component into a self-contained `release/` folder:

```sh
./scripts/build-linux.sh                    # everything (or: npm run build:linux)
./scripts/build-linux.sh auth tracking      # only some: frontend gateway auth tracking analytics
RELEASE_DIR=/opt/aerotrack ./scripts/build-linux.sh
```

| Output | Run it with |
|---|---|
| `release/auth-service/auth` (static binary) | `AEROTRACK_CONFIG=/etc/aerotrack/services.json ./auth` |
| `release/tracking-service/tracking-service` | `AEROTRACK_CONFIG=/etc/aerotrack/services.json ./tracking-service` |
| `release/analytics-service/` (app + vendored gems) | `cd analytics-service && AEROTRACK_CONFIG=… RAILS_ENV=production ruby bin/start` |
| `release/gateway/` (`dist/` + production `node_modules`) | `cd gateway && GATEWAY_CONFIG=/etc/aerotrack/gateway.json node dist/main.js` |
| `release/user-portal/`, `release/admin-portal/` | Static files, served by nginx/Caddy (see the [user portal runbook](docs/runbooks/user-portal.md#deploying-the-build)) |

- **Toolchains** (Ubuntu/Debian install commands are in [docs/runbooks/README.md](docs/runbooks/README.md#building-and-running-on-linux)): Node.js 22+, Go 1.25+, Rust 1.85+, Ruby 3.3+ with Bundler, and `build-essential`.
- **Tested on x86_64** (Debian 13) with Go 1.27.4, current stable Rust, Node 24.22 and Ruby 4.0.10. Each artifact was started against PostgreSQL 18 and Redis 8 and passed its readiness check.
- **Config paths:** release builds have no repo around them, so **always set `AEROTRACK_CONFIG` / `GATEWAY_CONFIG`**. JWT key paths inside `services.json` resolve relative to that file, e.g. `/etc/aerotrack/keys/`.

## Configuration in brief

All configuration lives in **two JSON files**. Both are git-ignored, and their `*.example.json` templates are committed:

| File | Read by | Contains |
|---|---|---|
| `config/services.json` | auth, tracking, analytics (each reads `shared` plus its own section), and Docker Compose through a generated `.env` | DB and Redis credentials, JWT settings, the internal service token, the GitHub OAuth app, the bootstrap admin, data providers, service URLs |
| `config/gateway.json` | gateway | Routing table, CORS, cookies, JWKS URL, CSRF, rate limits, WebSocket limits |

- **New keys after pulling:** run `npm run config:migrate`. It adds keys from the templates and never changes your values.
- **Other file locations:** set `AEROTRACK_CONFIG` or `GATEWAY_CONFIG`.
- **Validation:** services refuse to start on a missing value or a leftover `CHANGE_ME`.
- **Switch to real flight data:** set `tracking.provider` to `"opensky"`. Read the quota notes in the [tracking runbook](docs/runbooks/tracking-service.md#configuration-servicesjson--shared--tracking) first.

## Useful scripts

| Command | Does |
|---|---|
| `npm run setup` | First-time config, secrets, JWT keys, `.env` |
| `npm run config:migrate` | Add new config keys to existing local files |
| `npm run infra:up` / `infra:down` / `infra:logs` | Manage the Docker infrastructure |
| `npm run dev:<service>` | Run one component in development mode |
| `npm run icons` | Regenerate favicons from `public/favicon.svg` |
| `npm run build:linux` | Production build of everything into `release/` (Linux; see above) |
| `node scripts/build-airline-seed.mjs` | Rebuild the airline catalogue from OpenFlights |

## Tests

```sh
(cd services/auth-service && go test ./...)                      # unit + integration (needs infra; uses Redis DB 15)
(cd services/tracking-service && cargo test)                     # unit + API/live-store integration
(cd services/analytics-service && ruby test/event_consumer_test.rb)
npm --prefix gateway test                                        # guard, CSRF, WebSocket over real sockets
npm --prefix frontend run test:all                               # shared lib, user portal, admin console
```

## Repository layout

```
config/          JSON config templates (real files and keys are git-ignored)
docs/runbooks/   operating guide for every component
frontend/        Angular workspace: user-portal, admin-portal, shared (design system, HTTP interceptors)
gateway/         API gateway (TypeScript)
infra/           Postgres init script, Prometheus scrape config
scripts/         setup, config migration, airline seed, favicon generation
services/        auth-service (Go), tracking-service (Rust), analytics-service (Ruby)
```

## Common problems

| Problem | Fix |
|---|---|
| A service exits with `invalid config … CHANGE_ME` | `npm run setup` (first time) or `npm run config:migrate` (after pulling) |
| Every call takes about 2 s on Windows | Use `127.0.0.1` for service-to-service URLs, not `localhost` (see the [runbooks index](docs/runbooks/README.md)) |
| GitHub sign-in returns `github_not_configured` | Add the OAuth App credentials to `auth.github` |
| Live map doesn't render | Restart `npm run dev:user-portal` after changing `angular.json`; see the [user portal runbook](docs/runbooks/user-portal.md#troubleshooting) |

## Data sources and licences

- Airline catalogue: © [OpenFlights](https://openflights.org/data) contributors, ODbL 1.0 ([seed/README.md](services/tracking-service/seed/README.md)).
- Live data: [OpenSky Network](https://opensky-network.org) and [adsb.lol](https://adsb.lol) (open ADS-B data).
- Basemap: [OpenFreeMap](https://openfreemap.org), with © OpenMapTiles and © OpenStreetMap contributors.

## Roadmap

- [x] **Phase 0:** scaffold, configuration, Docker infrastructure, startup migrations, health and metrics
- [x] **Phase 1:** authentication (GitHub SSO users; admin username and password with argon2id and lockout; JWT/JWKS; refresh sessions)
- [x] **Phase 2:** tracking backend (airline catalogue; OpenSky, adsb.lol and simulator; Redis live state; pub/sub)
- [x] **Phase 3:** live tracking UI (airlines → flights → live map, 1–5 flights of one airline, WebSocket)
- [x] **Phase 4:** analytics service and admin dashboards
- [ ] **Phase 5:** Dockerfiles, CI, production hardening
