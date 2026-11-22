# AeroTrack runbooks

One runbook per component. Each covers what the component does, how to configure it, run it and test it, its API and data, monitoring, routine tasks and troubleshooting.

| Component | Stack | Port | Runbook |
|---|---|---|---|
| Infrastructure (PostgreSQL 18, Redis 8, Prometheus) | Docker Compose | 5432 / 6379 / 9090 | [infrastructure.md](infrastructure.md) |
| API gateway | Node.js 22+, Fastify, TypeScript | 8080 | [gateway.md](gateway.md) |
| auth-service | Go | 7001 | [auth-service.md](auth-service.md) |
| tracking-service | Rust (axum, sqlx) | 7002 | [tracking-service.md](tracking-service.md) |
| analytics-service | Ruby (Rails 8.1 API) | 7003 | [analytics-service.md](analytics-service.md) |
| User portal | Angular 22 | 4200 | [user-portal.md](user-portal.md) |
| Admin console | Angular 22 | 4201 | [admin-portal.md](admin-portal.md) |

## Request path

```
Browser ──► User portal :4200 / Admin console :4201   (dev server proxies /api, /ws, /health)
              │
              ▼
           Gateway :8080 ── verifies JWT, CSRF, rate limit, routes by prefix, live WebSocket /ws
              │
     ┌────────┼──────────────┬───────────────────┐
     ▼        ▼              ▼                   ▼
   auth     tracking      analytics          Redis pub/sub (live positions)
   :7001    :7002         :7003
     │        │              │
     └────────┴──── PostgreSQL 18 (one schema per service) · Redis 8 · Prometheus
```

## Conventions every service follows

These apply to every component and are not repeated in each runbook.

**Configuration**

- Backend services (auth, tracking, analytics) read **`config/services.json`**: the `shared` block plus their own section. The gateway reads **`config/gateway.json`**.
- Both files are git-ignored. Their templates, `config/*.example.json`, are committed.
- Create both files with `npm run setup`. After pulling changes, run `npm run config:migrate`: it adds new keys and never overwrites your values.
- To use a different file, set `AEROTRACK_CONFIG=/path/services.json` (backend services) or `GATEWAY_CONFIG=/path/gateway.json` (gateway).
- Every service checks its config at startup. A missing value, or a value still set to `CHANGE_ME`, makes it exit with an error that names the key.
- **Service-to-service URLs use `127.0.0.1`, not `localhost`.** On Windows, `localhost` resolves to IPv6 `::1` first, and each call then waits about 2 s before falling back to IPv4. Browser-facing URLs (portals, the GitHub callback) keep `localhost`.

**Health and metrics**

| Endpoint | Meaning |
|---|---|
| `GET /health/live` | The process is up. |
| `GET /health/ready` | Postgres and Redis are reachable. Returns 503 if either is not. |
| `GET /metrics` | Prometheus metrics: `http_requests_total`, `http_request_duration_seconds`, `process_cpu_seconds_total`, `process_resident_memory_bytes`. |

The Ruby service uses Rack names for the first two metrics: `http_server_requests_total` and `http_server_request_duration_seconds`.

**Internal trust**

- Every API route of a backend service requires the header `X-Internal-Token` (`shared.internalToken`), so only the gateway, or another service, can call it.
- The gateway strips any identity headers a client sends. After verifying the JWT, it sets `X-User-Id`, `X-User-Role` and `X-Session-Id` itself.

**Database migrations**

- Each service owns one schema and one login role in the `aerotrack` database.
- At startup it waits for Postgres, takes an advisory lock, and applies only **pending** migrations. Migrations are forward-only.
- **Nothing is ever forced.** An edited, missing or half-applied migration stops startup with an error.
- To change a schema, add a new migration file. Never edit one that has been applied.

**Logs**

All services log to stdout. Go (auth) and Rust (tracking) log JSON lines, the gateway logs pino JSON, and Rails (analytics) logs plain text lines. No log contains passwords, tokens or refresh-token values.

## Start everything (local development)

```sh
npm run infra:up            # Postgres, Redis, Prometheus — waits until healthy
npm run dev:auth            # each of these in its own terminal
npm run dev:tracking
npm run dev:analytics
npm run dev:gateway
npm run dev:user-portal     # http://localhost:4200
npm run dev:admin-portal    # http://localhost:4201
```

To check everything at once, open `GET http://localhost:8080/health/services` (development only). It returns the readiness of every backend service.

The `npm run dev:*` scripts work the same on Linux, macOS and Windows.

## Building and running on Linux

### 1. Install the toolchains (Ubuntu 24.04 / Debian 12+)

The install commands below are the upstream projects' standard instructions. The build and run steps in sections 2–4 were verified on x86_64 in the official `golang:1.27`, `rust:1`, `node:24` and `ruby:4.0` images (Debian 13), against PostgreSQL 18 and Redis 8.

```sh
sudo apt-get update
sudo apt-get install -y build-essential git curl ca-certificates libyaml-dev libssl-dev zlib1g-dev libffi-dev

# Node.js 24 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# Go (official tarball)
curl -fsSLO https://go.dev/dl/go1.27.4.linux-amd64.tar.gz
sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf go1.27.4.linux-amd64.tar.gz
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc

# Rust (rustup, stable)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"

# Ruby 4.0 (via mise; any Ruby manager works). Distro Ruby packages are usually too old.
curl https://mise.run | sh
~/.local/bin/mise use -g ruby@4.0
exec $SHELL -l    # reload PATH, then check: ruby -v && bundle -v

# Docker Engine + Compose plugin for the infrastructure: https://docs.docker.com/engine/install/
```

Native gem extensions (puma, rbs) compile with `build-essential`. `pg` and `nokogiri` install as precompiled Linux gems, so `libpq-dev` is **not** required.

### 2. Build

```sh
git clone https://github.com/nani-1205/AeroTrack.git && cd AeroTrack
./scripts/build-linux.sh                    # → ./release/  (or a subset: frontend gateway auth tracking analytics)
```

What the script runs for each component:

| Component | Commands |
|---|---|
| frontend | `cd frontend && npm ci && npx ng build user-portal && npx ng build admin-portal` → copies `dist/*/browser` |
| gateway | `cd gateway && npm ci && npm run build`, then `npm ci --omit=dev` in the release folder |
| auth | `cd services/auth-service && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o …/auth ./cmd/auth` |
| tracking | `cd services/tracking-service && cargo build --release --locked` |
| analytics | Copies the app, then `bundle config set --local deployment true` / `path vendor/bundle` / `without 'development test'` and `bundle install` |

- **Where to build.** The Go binary is static and runs on any x86_64 Linux. The Rust binary links against glibc, so build it on the **same distro release as the server, or an older one**. The analytics gems are compiled for the build machine's Ruby, so build them with the **same Ruby version** the server will run.
- **Line endings.** Build from a Linux `git clone`, not from a folder copied off a Windows checkout. `.gitattributes` pins the files where it matters (`*.sh`, `Gemfile.lock`, `bin/*`) to LF, but a clean clone avoids surprises.

### 3. Configure

```sh
node scripts/setup.mjs                 # creates config/services.json, config/gateway.json, config/keys/ and .env
sudo mkdir -p /etc/aerotrack && sudo cp -r config/services.json config/gateway.json config/keys /etc/aerotrack/
sudo chmod -R go-rwx /etc/aerotrack    # secrets: readable by the service user only
```

For production, edit `/etc/aerotrack/*.json`:
- set `env` to `"production"`;
- set `secure: true` for cookies;
- add your GitHub OAuth credentials;
- set the portal URLs and `cors.origins` for your domain.

Start the infrastructure with `npm run infra:up`, or point `shared.postgres` and `shared.redis` at managed services.

### 4. Run

Every release artifact needs its config path, because there is no repository around it:

```sh
export AEROTRACK_CONFIG=/etc/aerotrack/services.json
export GATEWAY_CONFIG=/etc/aerotrack/gateway.json
./release/auth-service/auth
./release/tracking-service/tracking-service
(cd release/analytics-service && RAILS_ENV=production ruby bin/start)
(cd release/gateway && node dist/main.js)
```

Serve `release/user-portal` and `release/admin-portal` with a web server (see [user-portal.md](user-portal.md#deploying-the-build)).

**Example systemd unit.** One per service; change `Description`, `WorkingDirectory` and `ExecStart`:

```ini
# /etc/systemd/system/aerotrack-auth.service
[Unit]
Description=AeroTrack auth-service
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=aerotrack
WorkingDirectory=/opt/aerotrack/auth-service
Environment=AEROTRACK_CONFIG=/etc/aerotrack/services.json
ExecStart=/opt/aerotrack/auth-service/auth
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

| Unit | `WorkingDirectory` | `Environment` | `ExecStart` |
|---|---|---|---|
| aerotrack-auth | `/opt/aerotrack/auth-service` | `AEROTRACK_CONFIG=…` | `/opt/aerotrack/auth-service/auth` |
| aerotrack-tracking | `/opt/aerotrack/tracking-service` | `AEROTRACK_CONFIG=…` | `/opt/aerotrack/tracking-service/tracking-service` |
| aerotrack-analytics | `/opt/aerotrack/analytics-service` | `AEROTRACK_CONFIG=…` and `RAILS_ENV=production` | `/usr/bin/env ruby bin/start`. Use the absolute path of the Ruby you built with, e.g. from `mise which ruby`. |
| aerotrack-gateway | `/opt/aerotrack/gateway` | `GATEWAY_CONFIG=/etc/aerotrack/gateway.json` | `/usr/bin/node dist/main.js` |

```sh
sudo useradd --system --home /opt/aerotrack aerotrack
sudo cp -r release/* /opt/aerotrack/ && sudo chown -R aerotrack: /opt/aerotrack /etc/aerotrack
sudo systemctl daemon-reload && sudo systemctl enable --now aerotrack-auth aerotrack-tracking aerotrack-analytics aerotrack-gateway
journalctl -u aerotrack-gateway -f
```
