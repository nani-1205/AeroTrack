//! OpenSky Network REST API — global state vectors (`GET /states/all`).
//! Anonymous access works with tight limits; with clientId/clientSecret an OAuth2
//! client-credentials token is fetched and cached.

use std::time::{Duration, Instant};

use anyhow::{Context, anyhow};
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::Value;

use super::{ProviderError, http_client};
use crate::config;
use crate::model::{Observation, Source};

pub struct OpenSky {
    cfg: config::OpenSky,
    http: reqwest::Client,
    token: Option<(String, Instant)>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
}

#[derive(Deserialize)]
struct StatesResponse {
    time: i64,
    states: Option<Vec<Vec<Value>>>,
}

impl OpenSky {
    pub fn new(cfg: config::OpenSky) -> anyhow::Result<Self> {
        Ok(Self { http: http_client(cfg.timeout_seconds)?, cfg, token: None })
    }

    async fn bearer(&mut self) -> anyhow::Result<Option<String>> {
        if !self.cfg.has_credentials() {
            return Ok(None);
        }
        if let Some((tok, valid_until)) = &self.token {
            if Instant::now() < *valid_until {
                return Ok(Some(tok.clone()));
            }
        }
        let res: TokenResponse = self
            .http
            .post(&self.cfg.token_url)
            .form(&[
                ("grant_type", "client_credentials"),
                ("client_id", self.cfg.client_id.as_str()),
                ("client_secret", self.cfg.client_secret.as_str()),
            ])
            .send()
            .await
            .context("OpenSky token request")?
            .error_for_status()
            .context("OpenSky token request")?
            .json()
            .await
            .context("OpenSky token response")?;
        let valid_until = Instant::now() + Duration::from_secs(res.expires_in.saturating_sub(60).max(30));
        self.token = Some((res.access_token.clone(), valid_until));
        Ok(Some(res.access_token))
    }

    pub async fn snapshot(&mut self) -> Result<Vec<Observation>, ProviderError> {
        let url = format!("{}/states/all", self.cfg.base_url.trim_end_matches('/'));
        let mut req = self.http.get(url);
        if let Some(tok) = self.bearer().await? {
            req = req.bearer_auth(tok);
        }
        let res = req.send().await.context("OpenSky states request")?;
        if res.status() == StatusCode::TOO_MANY_REQUESTS {
            let retry = res
                .headers()
                .get("x-rate-limit-retry-after-seconds")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse().ok());
            return Err(ProviderError::RateLimited(retry));
        }
        if res.status() == StatusCode::UNAUTHORIZED {
            self.token = None; // force a new token next time
        }
        let body = res.error_for_status().context("OpenSky states request")?.text().await.context("read OpenSky body")?;
        Ok(parse_states(&body)?)
    }
}

/// Parses `/states/all`. Each state is a positional array:
/// 0 icao24, 1 callsign, 2 origin_country, 3 time_position, 4 last_contact, 5 longitude,
/// 6 latitude, 7 baro_altitude, 8 on_ground, 9 velocity, 10 true_track, 11 vertical_rate,
/// 12 sensors, 13 geo_altitude, 14 squawk, 15 spi, 16 position_source.
pub fn parse_states(body: &str) -> anyhow::Result<Vec<Observation>> {
    let res: StatesResponse = serde_json::from_str(body).map_err(|e| anyhow!("parse OpenSky states: {e}"))?;
    let states = res.states.unwrap_or_default();
    let mut out = Vec::with_capacity(states.len());
    for s in states {
        let (Some(lon), Some(lat)) = (num(&s, 5), num(&s, 6)) else { continue };
        let Some(icao24) = s.first().and_then(Value::as_str) else { continue };
        out.push(Observation {
            icao24: icao24.to_lowercase(),
            callsign: s.get(1).and_then(Value::as_str).map(|c| c.trim().to_string()).filter(|c| !c.is_empty()),
            origin_country: s.get(2).and_then(Value::as_str).map(str::to_string),
            lat,
            lon,
            altitude_m: num(&s, 7).or_else(|| num(&s, 13)),
            ground_speed_ms: num(&s, 9),
            heading_deg: num(&s, 10),
            vertical_rate_ms: num(&s, 11),
            on_ground: s.get(8).and_then(Value::as_bool).unwrap_or(false),
            last_contact: s.get(4).and_then(Value::as_i64).unwrap_or(res.time),
            source: Source::Opensky,
            registration: None,
            aircraft_type: None,
            route: None,
        });
    }
    Ok(out)
}

fn num(s: &[Value], i: usize) -> Option<f64> {
    s.get(i).and_then(Value::as_f64).filter(|v| v.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shape matches a real /states/all response (values are illustrative).
    const SAMPLE: &str = r#"{"time":1795283044,"states":[
        ["801647","IGO6380 ","India",1795283035,1795283043,77.1127,28.5659,182.88,true,0.06,284.06,null,null,null,"0217",false,0],
        ["801657","AIC1GA  ","India",1795283044,1795283044,77.285,28.1852,4114.8,false,160.29,7.38,-2.6,null,4290.06,"2662",false,0],
        ["abc123",null,"United States",null,1795283000,null,null,null,false,null,null,null,null,null,null,false,0],
        ["a1b2c3","N123AB  ","United States",1795283040,1795283040,-73.9,40.7,null,false,60.0,180.0,0.0,null,950.0,null,false,0]
    ]}"#;

    #[test]
    fn parses_state_vectors() {
        let obs = parse_states(SAMPLE).unwrap();
        assert_eq!(obs.len(), 3, "the state without a position is skipped");

        let aic = obs.iter().find(|o| o.icao24 == "801657").unwrap();
        assert_eq!(aic.callsign.as_deref(), Some("AIC1GA"));
        assert_eq!((aic.lat, aic.lon), (28.1852, 77.285));
        assert_eq!(aic.altitude_m, Some(4114.8));
        assert_eq!(aic.vertical_rate_ms, Some(-2.6));
        assert!(!aic.on_ground);
        assert_eq!(aic.last_contact, 1795283044);

        assert!(obs.iter().find(|o| o.icao24 == "801647").unwrap().on_ground);
        let fallback = obs.iter().find(|o| o.icao24 == "a1b2c3").unwrap();
        assert_eq!(fallback.altitude_m, Some(950.0), "falls back to geometric altitude");
    }

    #[test]
    fn empty_states_is_not_an_error() {
        assert!(parse_states(r#"{"time":1,"states":null}"#).unwrap().is_empty());
    }
}
