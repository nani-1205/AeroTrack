# Runbook: admin console

**Code:** [frontend/projects/admin-portal/](../../frontend/projects/admin-portal) · **Stack:** Angular 22, hand-built SVG charts, Lucide icons, Inter · **Dev port:** 4201

The internal console for administrators: who is signed in, how the product is used, and how every service is performing. Admins sign in with a **username and password**, separate from GitHub.

## How it's used

| Route | Page |
|---|---|
| `/login` | Admin sign-in. A wrong password and an unknown username give the same message; after `maxFailedAttempts` the account is locked for `lockoutMinutes`. |
| `/change-password` | Required on first sign-in with the bootstrap password; also available any time from the sidebar. Has a strength meter and a requirements checklist. Changing it signs out your other sessions. |
| `/` | **Overview.** A time range (24 h / 7 d / 30 d) scopes the whole page: signed in now, registered users, aircraft tracked, live-map viewers; an **Activity** chart (sign-ins, tracking sessions, sign-ups); recent activity; most-tracked airlines and flights; top trackers; service health; failed admin sign-ins. Refreshes every 30 s. |
| `/users` | User directory: search, joined date, last sign-in, tracking sessions, last tracked, status. Pages of 25. |
| `/performance` | Per service (gateway, auth, tracking, analytics): status, requests/s, error rate, p95 latency, CPU, memory; **Requests per second** and **p95 latency** charts for 1 h / 6 h / 24 h. |

Every chart has a **chart/table toggle**, a legend, and a hover or keyboard tooltip (focus the chart, then use ← / → / Home / End). The series colours were validated for colour-blind safety; table view is the accessible alternative.

## First sign-in

1. Find the bootstrap credentials: `auth.admin.bootstrapUsername` (default `admin`) and `auth.admin.bootstrapPassword` in `config/services.json`. `npm run setup` also prints them once.
2. Open http://localhost:4201 and sign in.
3. You are taken to **Choose a new password** (at least 12 characters). Until you set it, the gateway blocks every admin API except the account endpoints (403 `password_change_required`).

The bootstrap password in `services.json` is **only used to create the first admin**. Changing it later does nothing unless no admin exists (see [auth-service.md](auth-service.md#routine-tasks) for resetting a forgotten password or unlocking an account).

## Configuration

Like the user portal, the console holds no secrets. It calls `/api/admin/*` and `/health/services` on its own origin; in development [frontend/proxy.conf.json](../../frontend/proxy.conf.json) forwards them to the gateway.

| Setting | Where |
|---|---|
| Chart colours (validated palette) | `SERIES_COLORS` in [charts/scale.ts](../../frontend/projects/admin-portal/src/app/charts/scale.ts) |
| Refresh intervals | `REFRESH_MS` in `pages/dashboard/dashboard.ts` and `pages/performance/performance.ts` (30 s) |
| Minimum password length shown in the UI | `MIN_ADMIN_PASSWORD_LENGTH` in `core/admin-auth.service.ts`. Must match `auth.admin.minPasswordLength`; the server enforces it. |

## Run, build, test

```sh
npm run dev:admin-portal                       # http://localhost:4201 (needs gateway, auth, analytics; Prometheus for Performance)
npm --prefix frontend run build:all            # → frontend/dist/admin-portal/browser
cd frontend && npx ng test admin-portal --watch=false     # 12 tests: sign-in, password change, strength meter, chart scales/line/bars
```

**Linux release build:** `./scripts/build-linux.sh frontend` builds both portals, and the console lands in `release/admin-portal/`.

**Deploying:** the same as the user portal (static files, `/api` and `/health` to the gateway, SPA fallback). Keep the console on a **separate origin**, ideally restricted to your network or VPN, and add that origin to `cors.origins`.

## Smoke check

After a deploy or restart, signed in as an admin:
1. **Overview:** all four tiles show numbers, and **Service health** shows 4 of 4 up.
2. **Performance:** every service row has requests/s and p95. The Analytics row fills in about 30 s after analytics starts.
3. **Users:** the list loads and search narrows it.

Each page names the upstream that failed if one is down.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Invalid username or password" with the right password | The bootstrap password was changed in `services.json` after the admin was created | Use the password you set; to reset, see [auth-service.md](auth-service.md#routine-tasks) |
| "This account is temporarily locked" | Too many failed attempts | Wait `lockoutMinutes`, or unlock with SQL |
| Redirected to Change password on every page | `mustChangePassword` still set | Complete the password change |
| "Some analytics could not be loaded" | analytics, auth or tracking down | `GET http://localhost:8080/health/services` |
| Performance page empty or "Prometheus unreachable" | Prometheus not running | `npm run infra:up` |
| Gateway shows a high error rate right after restarts | Real 503s from upstreams that were down during the restart, counted in the 5-minute window | They age out within 5 minutes |
| Top trackers shows "Unknown user" | Events from a user id that no longer exists (e.g. test data) | Remove test rows; see [analytics-service.md](analytics-service.md#routine-tasks) |
