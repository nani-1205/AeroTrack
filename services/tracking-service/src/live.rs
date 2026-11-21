//! Live flight state in Redis.
//!
//! Keys (contract shared with the gateway):
//!
//! | key                     | type   | content                                             |
//! |-------------------------|--------|-----------------------------------------------------|
//! | `trk:f:{icao24}`        | string | Flight JSON, TTL = staleAfterSeconds                |
//! | `trk:a:{ICAO}`          | zset   | icao24 → last contact (unix s) of active flights    |
//! | `trk:counts`            | zset   | airline ICAO → number of active flights             |
//! | `trk:t:{icao24}`        | list   | trail points "lat,lon,altM,ts" (oldest first)       |
//! | `trk:watch`             | zset   | icao24 → watch expiry (unix s)                      |
//! | channel `trk:pos:{ICAO}`| pubsub | `PositionBatch` JSON after every update             |

use std::collections::{BTreeMap, HashMap, HashSet};

use anyhow::{Context, Result};
use redis::aio::ConnectionManager;
use serde::Serialize;

use crate::config;
use crate::model::{Catalogue, Flight, Observation};

/// A callsign change or a gap this long starts a new flight (new `firstSeen`).
const NEW_LEG_GAP_S: i64 = 30 * 60;
const PIPELINE_CHUNK: usize = 500;

pub fn flight_key(icao24: &str) -> String {
    format!("trk:f:{icao24}")
}
pub fn airline_key(icao: &str) -> String {
    format!("trk:a:{icao}")
}
pub fn trail_key(icao24: &str) -> String {
    format!("trk:t:{icao24}")
}
pub fn channel(icao: &str) -> String {
    format!("trk:pos:{icao}")
}
pub const COUNTS_KEY: &str = "trk:counts";
pub const WATCH_KEY: &str = "trk:watch";

/// Published on `trk:pos:{ICAO}` whenever an airline's flights change.
#[derive(Debug, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PositionBatch {
    pub airline: String,
    pub ts: i64,
    pub flights: Vec<Flight>,
    pub removed: Vec<String>,
}

#[derive(Debug, Default, PartialEq)]
pub struct ApplyReport {
    pub upserted: usize,
    pub removed: usize,
    pub active: usize,
}

struct Known {
    airline: String,
    callsign: String,
    first_seen: i64,
    last_contact: i64,
    last_trail: i64,
}

/// In-memory view of active flights, owned by the ingest leader.
#[derive(Default)]
pub struct IngestState {
    known: HashMap<String, Known>,
}

impl IngestState {
    pub fn len(&self) -> usize {
        self.known.len()
    }

    fn callsign_of(&self, icao24: &str) -> Option<String> {
        self.known.get(icao24).map(|k| k.callsign.clone())
    }
}

#[derive(Clone)]
pub struct LiveStore {
    redis: ConnectionManager,
    stale_after: i64,
    trail: config::Trail,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectionError {
    Count { max: usize, got: usize },
    NotActive(Vec<String>),
    MixedAirlines(Vec<String>),
}

/// Users track 1..=max flights at once, all from the same airline. Returns that airline's ICAO.
pub fn validate_selection(ids: &[String], max: usize, found: &[Option<Flight>]) -> Result<String, SelectionError> {
    if ids.is_empty() || ids.len() > max {
        return Err(SelectionError::Count { max, got: ids.len() });
    }
    let missing: Vec<String> = ids.iter().zip(found).filter(|(_, f)| f.is_none()).map(|(id, _)| id.clone()).collect();
    if !missing.is_empty() {
        return Err(SelectionError::NotActive(missing));
    }
    let airlines: Vec<String> = found
        .iter()
        .flatten()
        .map(|f| f.airline_icao.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    match airlines.as_slice() {
        [one] => Ok(one.clone()),
        _ => Err(SelectionError::MixedAirlines(airlines)),
    }
}

/// Lower-cases, trims and de-duplicates requested icao24 ids, keeping order.
pub fn normalize_ids(ids: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    ids.iter()
        .map(|id| id.trim().to_lowercase())
        .filter(|id| !id.is_empty() && seen.insert(id.clone()))
        .collect()
}

impl LiveStore {
    pub fn new(redis: ConnectionManager, stale_after_seconds: u64, trail: config::Trail) -> Self {
        Self { redis, stale_after: stale_after_seconds as i64, trail }
    }

    // ------------------------------------------------------------------ writes

    /// Applies a complete snapshot from the global provider: upserts airborne airline flights,
    /// drops flights that landed or have not been seen for `staleAfterSeconds`, refreshes counts
    /// and publishes one batch per changed airline.
    pub async fn apply_snapshot(
        &self,
        state: &mut IngestState,
        catalogue: &Catalogue,
        observations: Vec<Observation>,
        now: i64,
    ) -> Result<ApplyReport> {
        let mut landed: Vec<String> = Vec::new();
        let mut flights = Vec::with_capacity(observations.len());
        for obs in &observations {
            let id = obs.icao24.to_lowercase();
            if obs.on_ground {
                if state.known.contains_key(&id) {
                    landed.push(id);
                }
                continue;
            }
            if let Some(f) = catalogue.classify(obs, obs.last_contact) {
                flights.push(f);
            }
        }

        let mut batches = self.write_flights(state, flights).await?;
        let upserted = batches.values().map(|b| b.flights.len()).sum();

        // Expire: landed now, or silent for too long.
        let cutoff = now - self.stale_after;
        let mut expired: Vec<String> =
            state.known.iter().filter(|(_, k)| k.last_contact < cutoff).map(|(id, _)| id.clone()).collect();
        expired.extend(landed);
        let removed = self.remove_flights(state, &expired, &mut batches, now).await?;

        self.write_counts(state).await?;
        self.publish(batches, now).await?;
        metrics::gauge!("tracking_active_flights").set(state.len() as f64);
        Ok(ApplyReport { upserted, removed, active: state.len() })
    }

    /// Applies high-frequency updates (watch provider) for flights that are already active.
    /// Fields the watch provider does not know (country, route, …) are kept from the stored record.
    pub async fn apply_updates(
        &self,
        state: &mut IngestState,
        catalogue: &Catalogue,
        observations: Vec<Observation>,
        now: i64,
    ) -> Result<usize> {
        let mut candidates = Vec::new();
        for mut obs in observations {
            obs.icao24 = obs.icao24.to_lowercase();
            let Some(known) = state.known.get(&obs.icao24) else { continue };
            if obs.last_contact <= known.last_contact || obs.on_ground {
                continue;
            }
            if obs.callsign.is_none() {
                obs.callsign = state.callsign_of(&obs.icao24);
            }
            if let Some(f) = catalogue.classify(&obs, known.first_seen) {
                candidates.push(f);
            }
        }
        if candidates.is_empty() {
            return Ok(0);
        }
        let ids: Vec<String> = candidates.iter().map(|f| f.icao24.clone()).collect();
        let existing = self.flights(&ids).await?;
        let merged: Vec<Flight> = candidates
            .into_iter()
            .zip(existing)
            .map(|(mut new, old)| {
                if let Some(old) = old {
                    new.origin_country = new.origin_country.or(old.origin_country);
                    new.registration = new.registration.or(old.registration);
                    new.aircraft_type = new.aircraft_type.or(old.aircraft_type);
                    new.route = new.route.or(old.route);
                }
                new
            })
            .collect();
        let batches = self.write_flights(state, merged).await?;
        let n = batches.values().map(|b| b.flights.len()).sum();
        self.publish(batches, now).await?;
        Ok(n)
    }

    async fn write_flights(&self, state: &mut IngestState, flights: Vec<Flight>) -> Result<BTreeMap<String, PositionBatch>> {
        let mut batches: BTreeMap<String, PositionBatch> = BTreeMap::new();
        let mut conn = self.redis.clone();
        for chunk in flights.chunks(PIPELINE_CHUNK) {
            let mut pipe = redis::pipe();
            for f in chunk {
                let mut f = f.clone();
                let known = state.known.get(&f.icao24);
                let continuing = known.is_some_and(|k| {
                    k.callsign == f.callsign && f.last_contact - k.last_contact < NEW_LEG_GAP_S
                });
                f.first_seen = if continuing { known.map(|k| k.first_seen).unwrap_or(f.last_contact) } else { f.last_contact };
                if let Some(k) = known.filter(|k| k.airline != f.airline_icao) {
                    pipe.zrem(airline_key(&k.airline), &f.icao24).ignore();
                }
                let trail_due = known.is_none_or(|k| !continuing || f.last_contact - k.last_trail >= self.trail.sample_seconds as i64);

                let json = serde_json::to_string(&f)?;
                pipe.set_ex(flight_key(&f.icao24), json, self.stale_after as u64).ignore();
                pipe.zadd(airline_key(&f.airline_icao), &f.icao24, f.last_contact).ignore();
                pipe.expire(airline_key(&f.airline_icao), self.stale_after * 2).ignore();
                if !continuing {
                    pipe.del(trail_key(&f.icao24)).ignore();
                }
                if trail_due {
                    let point = format!("{:.5},{:.5},{:.0},{}", f.lat, f.lon, f.altitude_m.unwrap_or(0.0), f.last_contact);
                    pipe.rpush(trail_key(&f.icao24), point).ignore();
                    pipe.ltrim(trail_key(&f.icao24), -(self.trail.max_points as isize), -1).ignore();
                }
                pipe.expire(trail_key(&f.icao24), self.stale_after).ignore();

                let last_trail = if trail_due { f.last_contact } else { known.map(|k| k.last_trail).unwrap_or(f.last_contact) };
                state.known.insert(
                    f.icao24.clone(),
                    Known {
                        airline: f.airline_icao.clone(),
                        callsign: f.callsign.clone(),
                        first_seen: f.first_seen,
                        last_contact: f.last_contact,
                        last_trail,
                    },
                );
                batches
                    .entry(f.airline_icao.clone())
                    .or_insert_with(|| PositionBatch { airline: f.airline_icao.clone(), ts: 0, flights: vec![], removed: vec![] })
                    .flights
                    .push(f);
            }
            pipe.query_async::<()>(&mut conn).await.context("write flights to redis")?;
        }
        Ok(batches)
    }

    async fn remove_flights(
        &self,
        state: &mut IngestState,
        ids: &[String],
        batches: &mut BTreeMap<String, PositionBatch>,
        now: i64,
    ) -> Result<usize> {
        let mut conn = self.redis.clone();
        let mut removed = 0;
        for chunk in ids.chunks(PIPELINE_CHUNK) {
            let mut pipe = redis::pipe();
            for id in chunk {
                let Some(k) = state.known.remove(id) else { continue };
                pipe.zrem(airline_key(&k.airline), id).ignore();
                pipe.del(flight_key(id)).ignore();
                pipe.del(trail_key(id)).ignore();
                batches
                    .entry(k.airline.clone())
                    .or_insert_with(|| PositionBatch { airline: k.airline.clone(), ts: now, flights: vec![], removed: vec![] })
                    .removed
                    .push(id.clone());
                removed += 1;
            }
            pipe.query_async::<()>(&mut conn).await.context("remove flights from redis")?;
        }
        Ok(removed)
    }

    async fn write_counts(&self, state: &IngestState) -> Result<()> {
        let mut counts: HashMap<&str, u64> = HashMap::new();
        for k in state.known.values() {
            *counts.entry(k.airline.as_str()).or_default() += 1;
        }
        let tmp = format!("{COUNTS_KEY}:tmp");
        let mut pipe = redis::pipe();
        pipe.atomic().del(&tmp).ignore();
        if counts.is_empty() {
            pipe.del(COUNTS_KEY).ignore();
        } else {
            let items: Vec<(u64, &str)> = counts.iter().map(|(a, n)| (*n, *a)).collect();
            pipe.zadd_multiple(&tmp, &items).ignore();
            pipe.rename(&tmp, COUNTS_KEY).ignore();
        }
        let mut conn = self.redis.clone();
        pipe.query_async::<()>(&mut conn).await.context("write airline counts")?;
        metrics::gauge!("tracking_active_airlines").set(counts.len() as f64);
        Ok(())
    }

    async fn publish(&self, batches: BTreeMap<String, PositionBatch>, now: i64) -> Result<()> {
        if batches.is_empty() {
            return Ok(());
        }
        let mut pipe = redis::pipe();
        for (airline, mut batch) in batches {
            batch.ts = now;
            pipe.publish(channel(&airline), serde_json::to_string(&batch)?).ignore();
        }
        let mut conn = self.redis.clone();
        pipe.query_async::<()>(&mut conn).await.context("publish position batches")?;
        Ok(())
    }

    // ------------------------------------------------------------------- reads

    /// Airlines with active flights, most first.
    pub async fn active_counts(&self, limit: usize) -> Result<Vec<(String, u64)>> {
        let mut conn = self.redis.clone();
        let rows: Vec<(String, f64)> = redis::cmd("ZRANGE")
            .arg(COUNTS_KEY)
            .arg(0)
            .arg(limit.saturating_sub(1) as isize)
            .arg("REV")
            .arg("WITHSCORES")
            .query_async(&mut conn)
            .await?;
        Ok(rows.into_iter().map(|(a, n)| (a, n as u64)).collect())
    }

    pub async fn counts_for(&self, icaos: &[String]) -> Result<Vec<u64>> {
        if icaos.is_empty() {
            return Ok(vec![]);
        }
        let mut conn = self.redis.clone();
        let scores: Vec<Option<f64>> = redis::cmd("ZMSCORE").arg(COUNTS_KEY).arg(icaos).query_async(&mut conn).await?;
        Ok(scores.into_iter().map(|s| s.unwrap_or(0.0) as u64).collect())
    }

    pub async fn flights(&self, ids: &[String]) -> Result<Vec<Option<Flight>>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let keys: Vec<String> = ids.iter().map(|id| flight_key(id)).collect();
        let mut conn = self.redis.clone();
        let raw: Vec<Option<String>> = redis::cmd("MGET").arg(&keys).query_async(&mut conn).await?;
        Ok(raw.into_iter().map(|r| r.and_then(|s| serde_json::from_str(&s).ok())).collect())
    }

    pub async fn flight(&self, icao24: &str) -> Result<Option<Flight>> {
        Ok(self.flights(&[icao24.to_lowercase()]).await?.pop().flatten())
    }

    /// Active flights of one airline, sorted by callsign.
    pub async fn airline_flights(&self, icao: &str) -> Result<Vec<Flight>> {
        let mut conn = self.redis.clone();
        let ids: Vec<String> = redis::cmd("ZRANGE").arg(airline_key(icao)).arg(0).arg(-1).query_async(&mut conn).await?;
        let found = self.flights(&ids).await?;
        let mut flights: Vec<Flight> = found.into_iter().flatten().filter(|f| f.airline_icao == icao).collect();
        flights.sort_by(|a, b| a.callsign.cmp(&b.callsign));
        Ok(flights)
    }

    /// Trail points `[lat, lon, altitudeM, unixSeconds]`, oldest first.
    pub async fn trail(&self, icao24: &str) -> Result<Vec<[f64; 4]>> {
        let mut conn = self.redis.clone();
        let raw: Vec<String> = redis::cmd("LRANGE").arg(trail_key(&icao24.to_lowercase())).arg(0).arg(-1).query_async(&mut conn).await?;
        Ok(raw
            .iter()
            .filter_map(|p| {
                let v: Vec<f64> = p.split(',').filter_map(|x| x.parse().ok()).collect();
                (v.len() == 4).then(|| [v[0], v[1], v[2], v[3]])
            })
            .collect())
    }

    /// Marks flights as watched until `now + ttl` (watch provider refreshes them).
    pub async fn watch(&self, ids: &[String], ttl_seconds: u64, now: i64) -> Result<()> {
        let until = now + ttl_seconds as i64;
        let items: Vec<(i64, &str)> = ids.iter().map(|id| (until, id.as_str())).collect();
        let mut conn = self.redis.clone();
        redis::pipe().zadd_multiple(WATCH_KEY, &items).ignore().query_async::<()>(&mut conn).await?;
        Ok(())
    }

    pub async fn watched(&self, now: i64, limit: usize) -> Result<Vec<String>> {
        let mut conn = self.redis.clone();
        let (ids,): (Vec<String>,) = redis::pipe()
            .cmd("ZREMRANGEBYSCORE").arg(WATCH_KEY).arg("-inf").arg(now).ignore()
            .cmd("ZRANGE").arg(WATCH_KEY).arg(0).arg(limit.saturating_sub(1) as isize)
            .query_async(&mut conn)
            .await
            .context("read watched flights")?;
        metrics::gauge!("tracking_watched_flights").set(ids.len() as f64);
        Ok(ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Source;

    fn flight(id: &str, airline: &str) -> Flight {
        Flight {
            icao24: id.into(), callsign: format!("{airline}1"), airline_icao: airline.into(), flight_number: "1".into(),
            origin_country: None, lat: 0.0, lon: 0.0, altitude_m: None, ground_speed_ms: None, heading_deg: None,
            vertical_rate_ms: None, on_ground: false, last_contact: 0, first_seen: 0, source: Source::Simulator,
            registration: None, aircraft_type: None, route: None,
        }
    }

    #[test]
    fn selection_requires_one_to_max_flights() {
        assert_eq!(validate_selection(&[], 5, &[]), Err(SelectionError::Count { max: 5, got: 0 }));
        let ids: Vec<String> = (0..6).map(|i| format!("a{i}")).collect();
        let found: Vec<_> = ids.iter().map(|id| Some(flight(id, "AIC"))).collect();
        assert_eq!(validate_selection(&ids, 5, &found), Err(SelectionError::Count { max: 5, got: 6 }));
        assert_eq!(validate_selection(&ids[..5], 5, &found[..5]), Ok("AIC".into()));
    }

    #[test]
    fn selection_must_be_one_airline_and_active() {
        let ids = vec!["a".to_string(), "b".to_string()];
        assert_eq!(
            validate_selection(&ids, 5, &[Some(flight("a", "AIC")), Some(flight("b", "BAW"))]),
            Err(SelectionError::MixedAirlines(vec!["AIC".into(), "BAW".into()]))
        );
        assert_eq!(
            validate_selection(&ids, 5, &[Some(flight("a", "AIC")), None]),
            Err(SelectionError::NotActive(vec!["b".into()]))
        );
    }

    #[test]
    fn normalizes_and_dedupes_ids() {
        let ids = vec![" ABC123 ".to_string(), "abc123".into(), "".into(), "def456".into()];
        assert_eq!(normalize_ids(&ids), vec!["abc123".to_string(), "def456".into()]);
    }
}
