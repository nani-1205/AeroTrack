//! Loads the `tracking` section (plus `shared`) from the single services JSON file.
// Provider/retention fields are consumed by the ingestion pipeline (Phase 2).
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Deserialize;

pub const ENV_CONFIG_PATH: &str = "AEROTRACK_CONFIG";
const DEFAULT_CONFIG_PATH: &str = "../../config/services.json";
const PLACEHOLDER: &str = "CHANGE_ME";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub env: String,
    pub shared: Shared,
    pub tracking: Tracking,
    #[serde(skip)]
    pub path: PathBuf,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shared {
    pub postgres: Postgres,
    pub redis: Redis,
    pub internal_token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Postgres {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub sslmode: String,
    pub connect_timeout_seconds: u64,
    pub startup_retries: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Redis {
    pub host: String,
    pub port: u16,
    pub password: String,
    pub db: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbCredentials {
    pub schema: String,
    pub user: String,
    pub password: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tracking {
    pub listen: String,
    pub db: DbCredentials,
    /// Active flight data provider: "opensky" | "adsbLol" | "simulator".
    pub provider: String,
    pub calls: Calls,
    pub max_tracked_flights: usize,
    pub position_retention_days: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Calls {
    pub opensky: OpenSky,
    pub adsb_lol: AdsbLol,
    pub simulator: Simulator,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSky {
    pub base_url: String,
    pub token_url: String,
    pub client_id: String,
    pub client_secret: String,
    pub poll_interval_seconds: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdsbLol {
    pub base_url: String,
    pub poll_interval_seconds: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Simulator {
    pub flights_per_airline: u32,
    pub tick_seconds: u64,
}

impl Config {
    pub fn load() -> Result<Self> {
        let path = std::env::var(ENV_CONFIG_PATH).unwrap_or_else(|_| DEFAULT_CONFIG_PATH.into());
        let path = std::path::absolute(Path::new(&path))?;
        let raw = std::fs::read_to_string(&path).with_context(|| {
            format!("read config {} (set {ENV_CONFIG_PATH} to override)", path.display())
        })?;
        let mut cfg: Config =
            serde_json::from_str(&raw).with_context(|| format!("parse config {}", path.display()))?;
        cfg.path = path;
        cfg.validate()
            .with_context(|| format!("invalid config {}", cfg.path.display()))?;
        Ok(cfg)
    }

    pub fn is_production(&self) -> bool {
        self.env == "production"
    }

    /// Non-fatal gaps acceptable in development.
    pub fn warnings(&self) -> Vec<String> {
        let mut w = Vec::new();
        let os = &self.tracking.calls.opensky;
        if self.tracking.provider == "opensky" && (os.client_id.is_empty() || os.client_secret.is_empty()) {
            w.push("tracking.calls.opensky clientId/clientSecret empty — anonymous OpenSky access has much lower rate limits".into());
        }
        w
    }

    fn validate(&self) -> Result<()> {
        let required = [
            ("shared.postgres.host", &self.shared.postgres.host),
            ("shared.postgres.database", &self.shared.postgres.database),
            ("shared.redis.host", &self.shared.redis.host),
            ("shared.redis.password", &self.shared.redis.password),
            ("shared.internalToken", &self.shared.internal_token),
            ("tracking.listen", &self.tracking.listen),
            ("tracking.db.schema", &self.tracking.db.schema),
            ("tracking.db.user", &self.tracking.db.user),
            ("tracking.db.password", &self.tracking.db.password),
        ];
        let mut errors: Vec<String> = required
            .iter()
            .filter_map(|(key, val)| match val.trim() {
                "" => Some(format!("{key} is required")),
                PLACEHOLDER => Some(format!("{key} is still {PLACEHOLDER:?} — run `npm run setup`")),
                _ => None,
            })
            .collect();

        if !matches!(self.tracking.provider.as_str(), "opensky" | "adsbLol" | "simulator") {
            errors.push(format!(
                "tracking.provider must be opensky | adsbLol | simulator (got {:?})",
                self.tracking.provider
            ));
        }
        if !(1..=5).contains(&self.tracking.max_tracked_flights) {
            errors.push("tracking.maxTrackedFlights must be between 1 and 5".into());
        }
        if self.is_production() {
            errors.extend(self.warnings());
        }
        if !errors.is_empty() {
            bail!(errors.join("; "));
        }
        Ok(())
    }
}
