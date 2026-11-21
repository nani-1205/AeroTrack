-- Forward-only migration. Never edit an applied migration (sqlx verifies checksums); add a new file.

-- Airline catalogue (seeded from open data in Phase 2). Airlines are matched to live
-- flights by the ICAO prefix of the callsign, e.g. "AIC123" -> AIC (Air India).
CREATE TABLE airlines (
    icao       CHAR(3)     PRIMARY KEY,
    iata       VARCHAR(2),
    name       TEXT        NOT NULL,
    callsign   TEXT,
    country    TEXT,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX airlines_iata_idx ON airlines (iata);
CREATE INDEX airlines_name_idx ON airlines (lower(name));
