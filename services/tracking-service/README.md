# tracking-service (Rust)

Ingests live positions (OpenSky, adsb.lol or the simulator), matches them to airlines, keeps live state and trails in Redis, publishes position batches for the live map, and serves the airline and flight API.

```sh
cargo run                  # from the repo root: npm run dev:tracking
cargo test                 # integration tests need `npm run infra:up`
```

Configuration: `config/services.json` → `shared` + `tracking`. Airline data: [seed/](seed/README.md) (OpenFlights, ODbL). **Operating guide: [docs/runbooks/tracking-service.md](../../docs/runbooks/tracking-service.md).**
