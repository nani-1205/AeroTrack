# Runbook: API gateway

**Code:** [gateway/](../../gateway) · **Stack:** Node.js 22+, Fastify 5, TypeScript · **Port:** 8080 · **Config:** `config/gateway.json`

The single entry point for both portals. It:
- verifies access tokens (RS256 JWT, checked against the auth-service JWKS) for the user or admin audience;
- enforces CSRF and rate limits;
- proxies `/api/*` to services by prefix, adding trusted identity headers;
- runs the **live-tracking WebSocket** (`/ws`), relaying Redis pub/sub position batches;
- publishes `track.start` usage events to the Redis stream `events:tracking`.

## Configuration (`config/gateway.json`)

| Key | Default | Meaning |
|---|---|---|
| `env` | `development` | `production` enforces `cookie.secure: true` and turns off `/health/services` |
| `listen.host` / `listen.port` | `0.0.0.0` / `8080` | Bind address |
| `cors.origins` | `http://localhost:4200`, `:4201` | Allowed browser origins. **Also the allowlist for WebSocket `Origin`.** |
| `cors.credentials` | `true` | Allow cookies |
| `cookie.secret` | random | Cookie signing secret |
| `cookie.secure` / `sameSite` | `false` / `lax` | Must be `true` behind HTTPS |
| `cookie.accessTokenName` / `adminAccessTokenName` | `aerotrack_at` / `aerotrack_admin_at` | Must match `auth.cookies.userAccess` / `adminAccess` in `services.json` |
| `jwt.jwksUrl` | `http://127.0.0.1:7001/.well-known/jwks.json` | auth-service public keys (cached 10 min, refetched for unknown key ids) |
| `jwt.issuer` / `userAudience` / `adminAudience` | `aerotrack-auth` / `aerotrack-user` / `aerotrack-admin` | Must match `shared.jwt` in `services.json` |
| `redis.*` | from `services.json` | Rate limiting, live pub/sub, event stream |
| `internalToken` | from `services.json` | Sent to services as `X-Internal-Token`. **Must equal `shared.internalToken`.** |
| `csrf.header` / `value` | `x-requested-with` / `aerotrack` | Required on every non-GET `/api` request |
| `rateLimit.max` / `windowSeconds` | `300` / `60` | Per client IP (shared through Redis); `/health*` and `/metrics` are exempt |
| `websocket.path` | `/ws` | Live-tracking socket |
| `websocket.maxFlightsPerClient` | `5` | Selection size limit (1–5) |
| `websocket.watchUrl` | `http://127.0.0.1:7002/flights/watch` | tracking-service watch endpoint |
| `websocket.heartbeatSeconds` | `30` | Ping interval; a client that misses a pong is terminated |
| `websocket.maxMessagesPer10s` | `20` | Client → server frames before closing with 4429 |
| `routes[]` | see below | `{ prefix, target, access: public / user / admin, allowPendingPasswordChange? }` |

**Routes.** The gateway strips `/api` and forwards the rest:

| Prefix | Target | Access |
|---|---|---|
| `/api/auth` | auth :7001 | public |
| `/api/account` | auth :7001 | user |
| `/api/admin/auth` | auth :7001 | public |
| `/api/admin/account` | auth :7001 | admin (also while a password change is pending) |
| `/api/airlines`, `/api/flights` | tracking :7002 | user |
| `/api/admin` | analytics :7003 | admin |

The most specific prefix wins, so `/api/admin/account` goes to auth while `/api/admin/*` goes to analytics. auth's `/internal/*` endpoints are deliberately **not** routed.

## Run

```sh
npm --prefix gateway install
npm run dev:gateway                  # tsx watch: restarts on source changes
npm --prefix gateway run build       # compiles to gateway/dist
npm --prefix gateway start           # node dist/main.js
GATEWAY_CONFIG=/etc/aerotrack/gateway.json npm --prefix gateway start
```

The gateway needs Redis at startup. auth-service only needs to be up when the first protected request arrives (for the JWKS).

**Linux release build** (toolchain setup: [Building and running on Linux](README.md#building-and-running-on-linux)):

```sh
./scripts/build-linux.sh gateway        # npm ci && npm run build, then production-only node_modules → release/gateway/
cd release/gateway && GATEWAY_CONFIG=/etc/aerotrack/gateway.json node dist/main.js
```

## Test

```sh
npm --prefix gateway run typecheck
npm --prefix gateway test            # 18 tests: guard, audiences, CSRF, trusted headers, 503 mapping, WebSocket over real sockets
```

## Behaviour reference

**Access checks**, per request:
1. The token is taken from `Authorization: Bearer …`, otherwise from the access cookie for that audience.
2. Results:

| Case | Response |
|---|---|
| No token | 401 `unauthorized` "missing credentials" |
| Invalid or expired token, or wrong audience | 401 `unauthorized` |
| JWKS unreachable | 503 `unavailable` |
| Admin token with `mcp` (must change password) on any route except `/api/admin/account/*` | 403 `password_change_required` |
| Mutating `/api` request without the CSRF header | 403 `csrf` |
| Upstream unreachable | 503 `unavailable` |
| Upstream timeout | 504 `timeout` |

**Headers.** The client's `x-internal-token`, `x-user-id`, `x-user-role`, `x-session-id` and `x-forwarded-for` are always stripped. The gateway then sets them itself, along with `x-request-id`.

**Live WebSocket (`/ws`)**

| Client → gateway | Gateway → client |
|---|---|
| `{"type":"subscribe","icao24":["a00000", …]}` (1–5) | `ready` (after auth) |
| `{"type":"unsubscribe"}` | `subscribed {airline, flights, watchTtlSeconds}` |
| `{"type":"ping"}` | `positions {ts, flights[], removed[]}`: only the subscribed flights |
|  | `ended`: every tracked flight has left |
|  | `error {error, message}`, e.g. `invalid_selection`, `mixed_airlines`, `not_active` |

- **Authentication:** the user access cookie, plus an `Origin` that is in `cors.origins`.
- **Subscribing:** the gateway validates the selection by calling tracking `POST /flights/watch`, and repeats the call every `watchTtlSeconds / 2` while subscribed.
- **Token expiry:** checked on each of those calls. Once the token has expired the socket closes with 4401, and the client refreshes its session and reconnects.
- **Close codes:**

| Code | Meaning |
|---|---|
| 4400 | Bad frame |
| 4401 | Unauthenticated or token expired |
| 4403 | Origin not allowed |
| 4429 | Too many messages |
| 4503 | auth-service unreachable |

## Monitoring

| Signal | Where |
|---|---|
| Liveness / readiness (Redis) | `GET /health/live`, `GET /health/ready` |
| All upstreams at once (development only) | `GET /health/services` |
| HTTP | `http_requests_total{method,route,status}`, `http_request_duration_seconds{method,route}` |
| WebSocket | `gateway_ws_connections`, `gateway_ws_subscriptions`, `gateway_ws_frames_total{direction,type}` |
| Node runtime | default prom-client metrics (event loop lag, heap, GC, `process_*`) |
| Logs | pino JSON on stdout. `level 40` = warn (e.g. `upstream unavailable`, `token rejected`), `50` = error |

## Routine tasks

- **Add or change a route:** edit `routes[]` in `gateway.json` and in `gateway.example.json`, then restart the gateway.
- **Add a portal domain (production):** add it to `cors.origins`, and set `cookie.secure: true` and `env: production`.
- **Rotate `internalToken`:** set the same new value in `gateway.json` and in `services.json` (`shared.internalToken`), then restart all four services.
- **Change rate limits:** change `rateLimit` and restart. Counters live in Redis (`gw:ratelimit:*`).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Every protected call returns **503** "authentication temporarily unavailable" | auth-service down, or `jwt.jwksUrl` wrong | Start auth; `curl http://127.0.0.1:7001/.well-known/jwks.json` |
| **503** `unavailable` on one prefix | That upstream service is down | Check `GET /health/services`, then start the service |
| **401** right after sign-in | Cookie names, issuer or audiences differ between `gateway.json` and `services.json` | Align `cookie.*Name` with `auth.cookies.*`, and `jwt.*` with `shared.jwt.*` |
| **403** `csrf` on POST | The client isn't sending `X-Requested-With: aerotrack` | The portals add it automatically; API clients must send it too |
| WebSocket closes with **4403** | The page's origin isn't in `cors.origins` | Add the origin |
| Each request takes about 2 s longer than it should | A target uses `localhost` on Windows (IPv6 first) | Use `127.0.0.1` in `routes[].target`, `jwksUrl` and `watchUrl` |
| `invalid config …` at startup | A key is missing or still `CHANGE_ME` | `npm run config:migrate`, then fill in the named key |
