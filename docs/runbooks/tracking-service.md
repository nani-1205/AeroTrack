# Runbook: tracking-service

**Code:** [services/tracking-service/](../../services/tracking-service) · **Stack:** Rust (edition 2024), axum 0.8, sqlx, tokio, redis · **Port:** 7002 · **Schema:** `tracking` (role `tracking_svc`)

Knows which airline flights are in the air right now. It:
- ingests positions from a **global provider** (OpenSky, or the built-in simulator);
- refreshes flights users are watching from the **watch provider** (adsb.lol);
- matches flights to airlines by the ICAO prefix of their callsign;
- keeps live state, trails and counts in Redis, and publishes a position batch per airline for the gateway's WebSocket;
- serves the airline, flight and watch API.

## Configuration (`services.json` → `shared` + `tracking`)

| Key | Default | Meaning |
|---|---|---|
| `tracking.listen` | `0.0.0.0:7002` | Bind address |
| `tracking.db.*` | `tracking` / `tracking_svc` / random | Schema, role and password |
| `tracking.provider` | `simulator` | Global feed: `simulator` (offline, development) or `opensky` (real data). `simulator` is rejected in production. |
| `tracking.watchProvider` | `adsbLol` | `adsbLol` or `none`. Only used with `opensky`; the simulator already updates every 2 s. |
| `calls.opensky.baseUrl` / `tokenUrl` | OpenSky defaults | REST API and OAuth2 token endpoint |
| `calls.opensky.clientId` / `clientSecret` | empty | Free OpenSky API client; empty means anonymous access |
| `calls.opensky.pollIntervalSeconds` | `90` | **Keep within the free quota** (see below) |
| `calls.opensky.timeoutSeconds` | `30` | HTTP timeout |
| `calls.adsbLol.baseUrl` / `apiKey` | `https://api.adsb.lol/v2` / empty | The key, if set, is sent as `api-auth` |
| `calls.adsbLol.pollIntervalSeconds` / `timeoutSeconds` / `maxConcurrent` | `5` / `10` / `5` | Watch refresh cadence and parallelism (at most 100 aircraft per cycle) |
| `calls.simulator.airlines` | 15 ICAO codes | Airlines to simulate (must exist in the catalogue) |
| `calls.simulator.flightsPerAirline` / `tickSeconds` / `seed` | `20` / `2` / `42` | World size, update cadence, deterministic seed |
| `tracking.maxTrackedFlights` | `5` | Selection limit for `POST /flights/watch` (1–5) |
| `tracking.staleAfterSeconds` | `300` | A flight not reported for this long is removed |
| `tracking.watchTtlSeconds` | `60` | How long a watch lasts without a refresh |
| `tracking.trail.sampleSeconds` / `maxPoints` | `30` / `240` | Trail resolution and length (about 2 h) |

**OpenSky quota.** A worldwide poll costs 4 API credits.

| Access | Daily credits | Minimum `pollIntervalSeconds` |
|---|---|---|
| Anonymous | about 400 | 900 |
| Free account (`clientId` / `clientSecret`) | about 4,000 | 90 |

The service logs a warning at startup when the interval would exceed the quota, and backs off on HTTP 429.

**Log level:** set with the `RUST_LOG` environment variable (default `info`), e.g. `RUST_LOG=tracking_service=debug,info`.

## Run

```sh
npm run dev:tracking                                    # cargo run (debug build)
cd services/tracking-service && cargo build --release
./target/release/tracking-service                       # AEROTRACK_CONFIG=… to point at another file
```

**Linux release build** (toolchain setup: [Building and running on Linux](README.md#building-and-running-on-linux)):

```sh
./scripts/build-linux.sh tracking        # = cargo build --release --locked (about 2 min from clean)
AEROTRACK_CONFIG=/etc/aerotrack/services.json ./release/tracking-service/tracking-service
```

- The binary (about 13 MB) embeds the migrations **and** the airline seed, so no other files are needed.
- It links dynamically against glibc, so build it on the same distro release as the server, or an older one.
- TLS for OpenSky and adsb.lol uses rustls, so OpenSSL is not required.

On startup the service:
1. checks its config and logs any quota warnings;
2. waits for Postgres and applies pending sqlx migrations;
3. **seeds the airline catalogue** (5,774 airlines; inserts only missing rows, never overwrites);
4. loads the catalogue into memory (reloaded every 10 min);
5. starts ingestion, then the HTTP server.

## Test

```sh
cd services/tracking-service && cargo test
```

21 tests:
- **Unit:** geo maths, callsign parsing, OpenSky and adsb.lol parsers, simulator (determinism, movement, position on route, take-off time), selection rules, backoff.
- **Integration:** the API and the live store against Postgres and Redis DB 15, run one at a time. They cover pub/sub, watch validation, expiry and merging watch updates.

## API

The gateway routes `/api/airlines/*` and `/api/flights/*` here for signed-in users. Every call needs `X-Internal-Token`. Units are SI: metres, m/s, degrees, unix seconds.

| Method & path | Returns |
|---|---|
| `GET /airlines?limit=100` | Airlines with flights in the air, busiest first: `{airlines:[{icao, iata, name, callsign, country, activeFlights}], total}` |
| `GET /airlines?search=…&limit=30` | Catalogue search by ICAO, IATA or name; exact codes first, then airlines with live flights |
| `GET /airlines/{icao}` | One airline with its live count (404 if unknown) |
| `GET /airlines/{icao}/flights` | `{airline, flights[]}`, sorted by callsign |
| `GET /flights/{icao24}?trail=true` | `{flight, airline, trail: [[lat, lon, altM, ts], …]}` (404 if not active) |
| `POST /flights/watch` `{"icao24":[…]}` | Validates **1–5 flights of one airline** and marks them watched for `watchTtlSeconds` |

`POST /flights/watch` can fail with:

| Status | Code | Meaning |
|---|---|---|
| 422 | `invalid_selection` | Fewer than 1 or more than 5 flights |
| 422 | `mixed_airlines` | The flights belong to more than one airline |
| 404 | `not_active` | One or more flights are no longer in the air. `inactive: […]` lists which. |

**Flight fields:** `icao24`, `callsign`, `airlineIcao`, `flightNumber`, `originCountry`, `lat`, `lon`, `altitudeM`, `groundSpeedMs`, `headingDeg`, `verticalRateMs`, `onGround`, `lastContact`, `firstSeen` (first observed by us, not take-off), `source` (`opensky` / `adsbLol` / `simulator`), `registration`, `aircraftType`, and `route`.

`route` is `{origin, destination, originPos, destinationPos, departedAt}`. Only the simulator knows routes; OpenSky does not report them.

## Data

**Postgres:** `tracking.airlines` (icao, iata, name, callsign, country, is_active). The seed is [seed/airlines.csv](../../services/tracking-service/seed/airlines.csv), © OpenFlights contributors, ODbL 1.0. Regenerate it with `node scripts/build-airline-seed.mjs`.

**Redis** (the contract with the gateway):

| Key | Type | Contents |
|---|---|---|
| `trk:f:{icao24}` | string | Flight JSON, TTL = `staleAfterSeconds` |
| `trk:a:{ICAO}` | zset | Airline's active flights → last contact |
| `trk:counts` | zset | ICAO → active-flight count |
| `trk:t:{icao24}` | list | Trail points `lat,lon,alt,ts` |
| `trk:watch` | zset | Watched icao24 → watch expiry |
| `trk:ingest:leader` | string | Leader lock: only the holder ingests. TTL = 3 × poll interval, at least 30 s. |
| channel `trk:pos:{ICAO}` | pub/sub | `{airline, ts, flights[], removed[]}` after every update |

**Ingestion rules:**
- Only airborne flights whose callsign looks like `ABC123` (a known airline ICAO code followed by a digit) are kept. Registrations such as `N123AB` are ignored.
- A flight that lands, or goes silent for `staleAfterSeconds`, is removed and listed in `removed[]`.
- Watch updates (adsb.lol) only refresh flights that are already active. They keep the existing country and route, and add registration and aircraft type.

## Monitoring

| Signal | Where |
|---|---|
| Readiness + **provider status** | `GET /health/ready`: `provider: {provider, isLeader, lastSuccess, lastError, lastCount}`. A provider failure **doesn't** fail readiness; cached state keeps being served. |
| Provider polls | `tracking_provider_polls_total{provider, result="ok"/"error"/"rate_limited"}`, `tracking_poll_duration_seconds` |
| Live state | `tracking_active_flights`, `tracking_active_airlines`, `tracking_watched_flights` |
| HTTP / process | `http_requests_total`, `http_request_duration_seconds` (histogram), `process_cpu_seconds_total`, `process_resident_memory_bytes` |
| Logs | JSON (tracing): `ingestion starting`, `provider poll failed`, quota warnings |

## Routine tasks

**Switch to real flight data:**
1. Optional: create a free OpenSky account and API client, and put its credentials in `calls.opensky`.
2. Set `provider: "opensky"` and `pollIntervalSeconds`: at least 90 with credentials, at least 900 without.
3. Restart. The first poll fills the map within one interval.

**Stuck leader after a crash.** A new instance won't ingest until the old lock expires (up to 3 × poll interval). To skip the wait:
```sh
docker compose exec redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning del trk:ingest:leader'
```

**Clear all live state.** It is rebuilt on the next poll:
```sh
docker compose exec redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning --scan --pattern "trk:*" | xargs -r redis-cli -a "$REDIS_PASSWORD" --no-auth-warning del'
```

**Rename or correct an airline.** Run `UPDATE tracking.airlines SET name = '…' WHERE icao = 'XYZ';`. The change shows within 10 min, or immediately after a restart. The seed never overwrites rows.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No airlines listed | Provider failing (`lastError` in `/health/ready`), or this instance isn't the leader (`isLeader: false`) | Read the error; delete the stale leader lock |
| `provider poll failed … rate limited` | OpenSky quota used up | Raise `pollIntervalSeconds`, add credentials; the service backs off automatically |
| A simulator airline never appears | Its ICAO code isn't in the catalogue (warning at startup) | Use a code from `seed/airlines.csv` |
| A flight "jumps" when tracking starts | Normal: OpenSky positions can be up to 90 s old; adsb.lol takes over within about 5 s once a flight is watched | Nothing to fix |
| `Worker`/map issues | Not this service | See [user-portal.md](user-portal.md) |
| `migration failed (nothing forced …)` | An applied migration was edited | Restore it; add a new migration instead |
