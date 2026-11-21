//! adsb.lol (open ADS-B data, ODbL) — per-aircraft lookups for watched flights (`GET /v2/hex/{hex}`).
//! Responses use readsb units (feet, knots, ft/min); converted to SI here.

use std::sync::Arc;

use anyhow::{Context, anyhow};
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use super::{ProviderError, http_client};
use crate::config;
use crate::model::{Observation, Source};

const FT_TO_M: f64 = 0.3048;
const KT_TO_MS: f64 = 0.514_444;
const FPM_TO_MS: f64 = 0.005_08;

#[derive(Clone)]
pub struct AdsbLol {
    cfg: config::AdsbLol,
    http: reqwest::Client,
}

#[derive(Deserialize)]
struct Response {
    /// Server time in milliseconds.
    now: f64,
    #[serde(default)]
    ac: Vec<Aircraft>,
}

#[derive(Deserialize)]
struct Aircraft {
    hex: String,
    flight: Option<String>,
    r: Option<String>,
    t: Option<String>,
    alt_baro: Option<Value>, // feet, or the string "ground"
    alt_geom: Option<f64>,
    gs: Option<f64>,
    track: Option<f64>,
    baro_rate: Option<f64>,
    geom_rate: Option<f64>,
    lat: Option<f64>,
    lon: Option<f64>,
    seen_pos: Option<f64>,
}

impl AdsbLol {
    pub fn new(cfg: config::AdsbLol) -> anyhow::Result<Self> {
        Ok(Self { http: http_client(cfg.timeout_seconds)?, cfg })
    }

    async fn lookup(&self, hex: &str) -> Result<Vec<Observation>, ProviderError> {
        let url = format!("{}/hex/{}", self.cfg.base_url.trim_end_matches('/'), hex.to_lowercase());
        let mut req = self.http.get(url);
        if !self.cfg.api_key.is_empty() {
            req = req.header("api-auth", &self.cfg.api_key);
        }
        let res = req.send().await.context("adsb.lol request")?;
        if res.status() == StatusCode::TOO_MANY_REQUESTS {
            return Err(ProviderError::RateLimited(None));
        }
        let body = res.error_for_status().context("adsb.lol request")?.text().await.context("read adsb.lol body")?;
        Ok(parse(&body)?)
    }

    /// Looks up several aircraft concurrently (bounded by `maxConcurrent`). Failed lookups are
    /// skipped; a rate limit aborts the batch so the caller can back off.
    pub async fn lookup_many(&self, hexes: Vec<String>) -> Result<Vec<Observation>, ProviderError> {
        let limit = Arc::new(Semaphore::new(self.cfg.max_concurrent));
        let mut tasks = JoinSet::new();
        for hex in hexes {
            let (me, limit) = (self.clone(), limit.clone());
            tasks.spawn(async move {
                let _permit = limit.acquire_owned().await;
                me.lookup(&hex).await
            });
        }
        let mut out = Vec::new();
        while let Some(joined) = tasks.join_next().await {
            match joined {
                Ok(Ok(obs)) => out.extend(obs),
                Ok(Err(ProviderError::RateLimited(r))) => return Err(ProviderError::RateLimited(r)),
                Ok(Err(e)) => tracing::debug!(error = %e, "adsb.lol lookup failed"),
                Err(e) => tracing::debug!(error = %e, "adsb.lol task failed"),
            }
        }
        Ok(out)
    }
}

pub fn parse(body: &str) -> anyhow::Result<Vec<Observation>> {
    let res: Response = serde_json::from_str(body).map_err(|e| anyhow!("parse adsb.lol response: {e}"))?;
    let now_s = res.now / 1000.0;
    Ok(res
        .ac
        .into_iter()
        .filter_map(|a| {
            let (lat, lon) = (a.lat?, a.lon?);
            let on_ground = matches!(&a.alt_baro, Some(Value::String(s)) if s == "ground");
            let altitude_m = match &a.alt_baro {
                Some(Value::Number(n)) => n.as_f64().map(|ft| ft * FT_TO_M),
                _ if on_ground => Some(0.0),
                _ => a.alt_geom.map(|ft| ft * FT_TO_M),
            };
            Some(Observation {
                icao24: a.hex.trim_start_matches('~').to_lowercase(),
                callsign: a.flight.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()),
                origin_country: None,
                lat,
                lon,
                altitude_m,
                ground_speed_ms: a.gs.map(|kt| kt * KT_TO_MS),
                heading_deg: a.track,
                vertical_rate_ms: a.baro_rate.or(a.geom_rate).map(|fpm| fpm * FPM_TO_MS),
                on_ground,
                last_contact: (now_s - a.seen_pos.unwrap_or(0.0)).round() as i64,
                source: Source::AdsbLol,
                registration: a.r,
                aircraft_type: a.t,
                route: None,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shape matches a real adsb.lol v2 response (values are illustrative, fields trimmed).
    const SAMPLE: &str = r#"{"ac":[
        {"hex":"76cdb2","type":"adsb_icao","flight":"SIA301  ","r":"9V-SMR","t":"A359","alt_baro":39000,"alt_geom":40450,"gs":519,"track":127.09,"baro_rate":-640,"lat":28.882828,"lon":76.076572,"seen_pos":2.0},
        {"hex":"800abc","flight":"IGO22","alt_baro":"ground","gs":12,"track":90,"lat":28.56,"lon":77.1,"seen_pos":0},
        {"hex":"~2d0001","flight":"TIS1","alt_baro":1200,"lat":1.0,"lon":2.0},
        {"hex":"800def","flight":"AIC9"}
    ],"msg":"No error","now":1795283050000,"total":4}"#;

    #[test]
    fn converts_readsb_units_to_si() {
        let obs = parse(SAMPLE).unwrap();
        assert_eq!(obs.len(), 3, "aircraft without a position are skipped");

        let sia = &obs[0];
        assert_eq!(sia.callsign.as_deref(), Some("SIA301"));
        assert!((sia.altitude_m.unwrap() - 11_887.2).abs() < 0.1, "39000 ft ≈ 11887 m");
        assert!((sia.ground_speed_ms.unwrap() - 267.0).abs() < 0.5, "519 kt ≈ 267 m/s");
        assert!((sia.vertical_rate_ms.unwrap() + 3.25).abs() < 0.01, "-640 ft/min ≈ -3.25 m/s");
        assert_eq!(sia.last_contact, 1_795_283_048);
        assert_eq!((sia.registration.as_deref(), sia.aircraft_type.as_deref()), (Some("9V-SMR"), Some("A359")));

        let ground = &obs[1];
        assert!(ground.on_ground);
        assert_eq!(ground.altitude_m, Some(0.0));

        assert_eq!(obs[2].icao24, "2d0001", "non-ICAO '~' prefix is stripped");
    }
}
