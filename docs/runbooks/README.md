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
