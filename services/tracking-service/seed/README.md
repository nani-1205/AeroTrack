# Seed data

## `airlines.csv`

The airline catalogue loaded into `tracking.airlines` when the service starts. Loading uses `INSERT … ON CONFLICT DO NOTHING`, so rows you edit in the database are never overwritten.

- **Source:** [OpenFlights airline database](https://openflights.org/data). © OpenFlights contributors, licensed under the **Open Database License (ODbL) 1.0**.
- **Changes from the source:**
  - only rows with a valid 3-letter ICAO code are kept;
  - placeholder rows (`Unknown`, `Private flight`) are dropped;
  - duplicate ICAO codes are reduced to one row, preferring the active entry and then the oldest.
- **Regenerate:** `node scripts/build-airline-seed.mjs`

Live flights are matched to airlines by the ICAO prefix of their ATC callsign. For example, `AIC101` belongs to `AIC` (Air India).
