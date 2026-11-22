# Runbook: analytics-service

**Code:** [services/analytics-service/](../../services/analytics-service) · **Stack:** Ruby 3.3+ (developed on 4.0), Rails 8.1 (API-only: railties, activerecord, actionpack), Puma, redis-rb, prometheus-client · **Port:** 7003 · **Schema:** `analytics` (role `analytics_svc`)

Powers the admin console. It:
- **consumes usage events** from Redis streams (sign-ins and sign-ups from auth; live-tracking sessions from the gateway) into Postgres;
- **combines** them with user counts from auth-service, live traffic from tracking-service and system metrics from Prometheus;
- serves the admin API.

## Configuration (`services.json` → `shared` + `analytics`)

| Key | Default | Meaning |
|---|---|---|
| `analytics.listen` | `0.0.0.0:7003` | Puma bind address |
| `analytics.db.*` | `analytics` / `analytics_svc` / random | Schema, role and password (used by `config/database.yml`) |
| `analytics.secretKeyBase` | random | Rails `secret_key_base`; no Rails credentials files are used |
| `analytics.calls.prometheus` | `http://127.0.0.1:9090` | Prometheus HTTP API |
| `analytics.calls.auth` / `tracking` | `http://127.0.0.1:7001` / `:7002` | Internal service calls, made with `shared.internalToken` |
| `analytics.calls.timeoutSeconds` | `5` | Timeout for every outgoing call |
| `analytics.streams.auth` / `tracking` | `events:auth` / `events:tracking` | Stream names (contract with auth and the gateway) |
| `analytics.streams.group` | `analytics` | Consumer group |
| `analytics.streams.batchSize` / `blockMs` | `500` / `5000` | Entries read per call and how long a read blocks |

**Rails environment:** set `RAILS_ENV` (default `development`). In `production`, code is eager-loaded.

## Run

```sh
cd services/analytics-service
bundle config set --local path vendor/bundle && bundle install     # first time
cd ../.. && npm run dev:analytics                                  # = ruby bin/start
```

[bin/start](../../services/analytics-service/bin/start):
1. boots Rails;
2. waits for Postgres;
3. applies pending migrations under an advisory lock, refusing to start if the database has migrations missing from `db/migrate`;
4. starts the **event consumer** thread;
5. runs Puma (single process).

**Linux release build** (toolchain setup: [Building and running on Linux](README.md#building-and-running-on-linux)):

```sh
./scripts/build-linux.sh analytics
#  copies the app to release/analytics-service/, then:
#  bundle config set --local deployment true && bundle config set --local path vendor/bundle
#  bundle config set --local without 'development test' && bundle install
cd release/analytics-service && AEROTRACK_CONFIG=/etc/aerotrack/services.json RAILS_ENV=production ruby bin/start
```

- **Self-contained:** the folder holds the app, its gems in `vendor/bundle` (about 90 MB), and its own `.bundle/config`. `config/boot.rb` uses that config even when the environment sets `BUNDLE_APP_CONFIG`, as the official Ruby Docker image does.
- **Same Ruby version:** gems with native extensions (puma, rbs) are compiled for the build machine's Ruby, so run the release with the same Ruby version.
- **Strict lockfile:** deployment mode uses `Gemfile.lock` exactly as committed. If Bundler says "Your lockfile needs to be updated", the lockfile probably has Windows line endings. Build from a fresh Linux `git clone`; `.gitattributes` keeps `Gemfile.lock` LF.

> **Windows:** start it with `ruby bin/start`, not `bundle exec ruby bin/start`. On Windows, stopping the `bundle exec` wrapper leaves Puma running and holding the port. `config/boot.rb` already loads Bundler.

## Test

```sh
cd services/analytics-service && ruby test/event_consumer_test.rb    # stream-entry parsing (no DB/Redis needed)
```

The admin API is also exercised end to end through the gateway; see the admin console smoke check in [admin-portal.md](admin-portal.md).

## API

The gateway routes `/api/admin/*` here for admins. Every call needs `X-Internal-Token` **and** `X-User-Role: admin`; both are set by the gateway after it verifies an admin JWT.

| Method & path | Returns |
|---|---|
| `GET /admin/overview` | `users` (total, newToday, new7d, activeToday, active7d, signedInNow), `admins.signedInNow`, `tracking` (aircraftNow, airlinesNow, liveViewers, sessionsToday), `today` (userLogins, signups, failedAdminLogins), `services[]` (up/down) |
| `GET /admin/activity?range=24h/7d/30d` | Zero-filled UTC buckets (hourly for 24h, daily otherwise): userLogins, signups, trackingSessions, failedAdminLogins, plus totals |
| `GET /admin/top?range=…` | Top 8 airlines (sessions, flights), top 10 callsigns, top 5 trackers |
| `GET /admin/users?search=&limit=25&offset=0` | auth's user directory with trackingSessions and lastTrackedAt per user |
| `GET /admin/events?limit=20` | Latest auth and tracking events, with user names resolved |
| `GET /admin/performance?range=1h/6h/24h` | Per service: up, requestsPerSecond, errorRate, p95Ms, cpuPercent, memoryMb (5-minute window); series of requests/s and p95 (60 points) |

Each upstream (auth, tracking, Prometheus) is fetched on its own: if one is down, only its numbers come back `null` and the rest of the response is returned. `/admin/performance` returns 503 if Prometheus is unreachable, and `/admin/users` returns 503 if auth is.

## Data

**Tables (schema `analytics`):**

| Table | Contents |
|---|---|
| `auth_events` | stream_id (unique), event_type, subject_type, subject_id, occurred_at |
| `tracking_events` | stream_id (unique), event_type (`track.start`), user_id, airline_icao, icao24s[], callsigns[], flight_count, occurred_at |
| `daily_stats` | Phase 0 placeholder (unused) |

**Event ingestion** ([lib/event_consumer.rb](../../services/analytics-service/lib/event_consumer.rb)):

- **Delivery:** the consumer reads with `XREADGROUP` (consumer group `analytics`, consumer `analytics-<hostname>`) and acknowledges each batch after inserting it. Delivery is **at-least-once**; inserts are **idempotent** because `stream_id` is unique.
- **Backfill:** the group is created at id `0`, so on first start everything already in the streams is imported.
- **Restarts:** entries left unacknowledged by a crash are re-read at startup, because the consumer name is stable per host.
- **Retention:** the streams are capped at about 100,000 entries (`MAXLEN ~`) by their producers.

**Prometheus queries used:** `up`, `rate(http_requests_total / http_server_requests_total)`, the 5xx ratio, `histogram_quantile(0.95, …_duration_seconds_bucket)`, `rate(process_cpu_seconds_total)`, `process_resident_memory_bytes`, `sum(gateway_ws_connections)`.

## Monitoring

| Signal | Where |
|---|---|
| Readiness (Postgres + Redis) | `GET /health/ready` |
| HTTP | `http_server_requests_total{code,method,path}`, `http_server_request_duration_seconds` (Rack collector) |
| Process | `process_cpu_seconds_total` (`Process.times`), `process_resident_memory_bytes` (`/proc` on Linux, psapi on Windows) |
| Consumer health | log lines `event consumer: …`; stream backlog: `XPENDING events:auth analytics` |
| Logs | Rails request log on stdout; `… unavailable: …` warnings when an upstream is down |

## Routine tasks

**Check the consumer is keeping up:**
```sh
docker compose exec redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning XINFO GROUPS events:auth'
# "pending" should be 0 and "lag" small
```

**Re-import everything still in the streams.** Safe, because inserts are deduplicated:
```sh
docker compose exec redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning XGROUP SETID events:auth analytics 0'
docker compose exec redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning XGROUP SETID events:tracking analytics 0'
```

**Remove test data** (e.g. sessions created by scripts under a fake user id). Delete it from both the table and the stream, or a later re-import brings it back:
```sql
DELETE FROM analytics.tracking_events WHERE user_id = '<fake-id>';
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Admin pages show "Some analytics could not be loaded" | One upstream is down (auth, tracking or Prometheus) | `GET http://localhost:8080/health/services`; `npm run infra:up` for Prometheus |
| Performance page: "metrics backend (Prometheus) is unreachable" | Prometheus container stopped | `npm run infra:up` |
| Every admin call takes about 2 s or more | `analytics.calls.*` use `localhost` on Windows | Use `127.0.0.1` |
| Analytics row on the Performance page shows `—` | Fewer than 2 scrapes yet (rates need two samples), or the service restarted recently | Wait about 30 s |
| Counts don't grow after sign-ins | Consumer thread stopped | Check the logs for `event consumer:`; restart; check `XINFO GROUPS` |
| `cannot load such file -- fiddle` | Ruby 3.5+ moved `fiddle` to a bundled gem | `bundle install` (it's in the Gemfile for Windows) |
| Port 7003 still in use after stopping | Started with `bundle exec` on Windows (orphan Puma) | Stop the `ruby.exe … bin/start` process; use `ruby bin/start` |
| `database has applied migrations missing from db/migrate` | A migration file was deleted | Restore it; never delete applied migrations |
