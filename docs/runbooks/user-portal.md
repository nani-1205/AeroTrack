# Runbook: user portal

**Code:** [frontend/projects/user-portal/](../../frontend/projects/user-portal) (shared code in [frontend/projects/shared/](../../frontend/projects/shared)) · **Stack:** Angular 22 (standalone, signals, zoneless), MapLibre GL 6, Lucide icons, Inter · **Dev port:** 4200

The public web app. People sign in with GitHub, pick an airline, select 1–5 of its flights in the air, and follow them live on a map.

## How it's used

| Route | Page |
|---|---|
| `/login` | Sign in with GitHub. Errors from the auth-service (`?error=…`) are shown in plain language. |
| `/` | **Airlines:** summary figures (aircraft airborne, airlines flying, busiest airline, last update), search (press `/`), sort by Busiest or A–Z. Refreshes every 30 s. |
| `/airlines/{ICAO}` | **Flights in the air** for that airline: fleet figures and a sortable table (route, altitude, speed, heading, vertical rate, aircraft, airborne). Tick **up to 5** flights; the selection tray shows them in their map colours; **Track live**. Refreshes every 20 s. |
| `/track?ids=a,b,c` | **Live map:** coloured, heading-rotated aircraft, solid flown trails, the **dashed planned great-circle route** with airport markers, and dead-reckoned motion between updates (at most 120 s ahead). The side panel shows each flight's route progress (% done, km to go) and telemetry. |

**Units shown:** feet, knots, ft/min. "Airborne" counts from take-off when the feed knows it; otherwise the card says "Tracked for" (time since first observed).

## Configuration

The portal holds **no secrets**. Everything it needs is either same-origin or set as an injection token:

| Setting | Where | Default |
|---|---|---|
| API base | `API_BASE_URL` in [shared/src/lib/api.ts](../../frontend/projects/shared/src/lib/api.ts) | `/api` |
| Live socket | `LIVE_SOCKET_URL` in [core/live-socket.ts](../../frontend/projects/user-portal/src/app/core/live-socket.ts) | same host, `/ws` |
| Basemap style | `MAP_STYLE_URL` in [core/map-config.ts](../../frontend/projects/user-portal/src/app/core/map-config.ts) | OpenFreeMap **positron** (free, no key) |
| Map label font | `MAP_LABEL_FONT` | `Noto Sans Regular` (served by OpenFreeMap) |
| MapLibre worker | `MAP_WORKER_URL` | `/maplibre/maplibre-gl-worker.mjs`, copied by `angular.json` assets |
| Flight colours | `FLIGHT_COLORS` | 5 colours, in selection order |
| CSRF header | `CSRF_HEADER` / `CSRF_VALUE` in `api.ts` | `X-Requested-With: aerotrack` (must match `gateway.json` → `csrf`) |

**Dev proxy** ([frontend/proxy.conf.json](../../frontend/proxy.conf.json)): `/api`, `/health` and `/ws` go to the gateway at `http://127.0.0.1:8080`.

## Run, build, test

```sh
npm --prefix frontend install                # first time
npm run dev:user-portal                      # http://localhost:4200 (needs the gateway running)
npm --prefix frontend run build:all          # → frontend/dist/user-portal/browser
cd frontend && npx ng test user-portal --watch=false     # 26 tests
npm run icons                                # regenerate favicon.ico / apple-touch-icon from public/favicon.svg
```

**Linux release build:** `./scripts/build-linux.sh frontend` builds both portals and copies them to `release/user-portal/` and `release/admin-portal/`.

The initial bundle is about 365 kB (about 88 kB over the wire). MapLibre (about 1 MB) is a lazy chunk that only the map page loads.

## Deploying the build

Serve `dist/user-portal/browser` as static files. From the same origin:
- route `/api`, `/ws` (WebSocket upgrade) and `/health` to the gateway;
- fall back to `index.html` for every other path (single-page app).

Using the same origin keeps cookies first-party and makes CSRF and CORS simple. Then:
- add the public origin to `gateway.json` → `cors.origins`;
- point `auth.portals.userUrl` and the GitHub OAuth App at the public URLs;
- set `cookie.secure` / `auth.cookies.secure` to `true`.

## Session behaviour

- Tokens are **httpOnly cookies**; the app never sees them.
- On a 401, one shared refresh request runs (`POST /api/auth/refresh`) and the original request is retried. If the refresh fails, the user is sent to `/login?error=session_expired`.
- **Live socket:** when it closes with 4401 (token expired), the client refreshes and reconnects. Other drops reconnect with backoff (1 s → 30 s) and re-subscribe.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "The basemap is taking too long to load" / grey map with no planes | The MapLibre worker isn't being served (`Worker failed to load` in the console) | Check `http://localhost:4200/maplibre/maplibre-gl-worker.mjs` returns 200; **restart `ng serve` after changing `angular.json`** |
| Map tiles missing, but aircraft and panel work | OpenFreeMap unreachable (offline or firewall) | Allow `tiles.openfreemap.org`, or set `MAP_STYLE_URL` to another MapLibre style |
| A flight seems far from its departure airport | Normal: long routes follow great circles (e.g. Kolkata → Atlanta over the Arctic), and the simulator starts flights mid-route | The dashed route line shows the path; the card shows % of the way |
| Sign-in loops back to `/login` | Gateway or auth not running, or cookie / audience mismatch | `GET /health/services`; see [gateway.md](gateway.md) troubleshooting |
| "Live tracking stopped: … same airline" | The selection mixed airlines (only possible by hand-editing the URL) | Select flights from one airline page |
| Old Angular icon in the tab | Browser favicon cache | Hard refresh (Ctrl+F5). After changing icons, bump `?v=` in `src/index.html`. |
| Changes to `angular.json` or `proxy.conf.json` have no effect | The dev server reads them only at startup | Restart `npm run dev:user-portal` |
