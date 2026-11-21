//! Airline catalogue: idempotent seed from the bundled OpenFlights CSV and loading into memory.

use anyhow::{Context, Result};
use serde::Deserialize;
use sqlx::PgPool;
use tracing::info;

use crate::model::{Airline, Catalogue};

/// © OpenFlights contributors, ODbL 1.0 — see seed/README.md.
const SEED_CSV: &str = include_str!("../seed/airlines.csv");

#[derive(Debug, Deserialize)]
struct SeedRow {
    icao: String,
    iata: String,
    name: String,
    callsign: String,
    country: String,
    active: String,
}

fn non_empty(s: String) -> Option<String> {
    if s.trim().is_empty() { None } else { Some(s) }
}

fn seed_rows() -> Result<Vec<SeedRow>> {
    csv::Reader::from_reader(SEED_CSV.as_bytes())
        .deserialize()
        .collect::<Result<Vec<SeedRow>, _>>()
        .context("parse seed/airlines.csv")
}

/// Inserts missing airlines. Existing rows (including manual edits) are never overwritten.
pub async fn seed(pool: &PgPool) -> Result<u64> {
    let rows = seed_rows()?;
    let mut icao = Vec::with_capacity(rows.len());
    let mut iata = Vec::with_capacity(rows.len());
    let mut name = Vec::with_capacity(rows.len());
    let mut callsign = Vec::with_capacity(rows.len());
    let mut country = Vec::with_capacity(rows.len());
    let mut active = Vec::with_capacity(rows.len());
    for r in rows {
        icao.push(r.icao);
        iata.push(non_empty(r.iata));
        name.push(r.name);
        callsign.push(non_empty(r.callsign));
        country.push(non_empty(r.country));
        active.push(r.active == "Y");
    }
    let inserted = sqlx::query(
        "INSERT INTO airlines (icao, iata, name, callsign, country, is_active)
         SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::bool[])
         ON CONFLICT (icao) DO NOTHING",
    )
    .bind(&icao)
    .bind(&iata)
    .bind(&name)
    .bind(&callsign)
    .bind(&country)
    .bind(&active)
    .execute(pool)
    .await
    .context("seed airlines")?
    .rows_affected();
    info!(inserted, total_in_seed = icao.len(), "airline catalogue seeded");
    Ok(inserted)
}

/// Loads every airline (active or not: flights are matched by callsign prefix regardless).
pub async fn load(pool: &PgPool) -> Result<Catalogue> {
    let rows: Vec<(String, Option<String>, String, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT trim(icao), iata, name, callsign, country FROM airlines")
            .fetch_all(pool)
            .await
            .context("load airlines")?;
    Ok(Catalogue::new(rows.into_iter().map(|(icao, iata, name, callsign, country)| Airline {
        icao,
        iata,
        name,
        callsign,
        country,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_seed_parses_and_contains_major_airlines() {
        let rows = seed_rows().unwrap();
        assert!(rows.len() > 1000, "seed unexpectedly small: {}", rows.len());
        for code in ["AIC", "IGO", "BAW", "UAL", "SIA"] {
            assert!(rows.iter().any(|r| r.icao == code), "{code} missing from seed");
        }
        assert!(rows.iter().all(|r| r.icao.len() == 3 && r.icao.chars().all(|c| c.is_ascii_uppercase())));
    }
}
