//! Loads the `tracking` section (plus `shared`) from the single services JSON file.

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum ProviderKind {
    #[serde(rename = "opensky")]
    OpenSky,
    #[serde(rename = "simulator")]
    Simulator,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum WatchProviderKind {
    #[serde(rename = "adsbLol")]
    AdsbLol,
    #[serde(rename = "none")]
    None,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tracking {
    pub listen: String,
    pub db: DbCredentials,
    /// Global feed that decides which flights are active: "opensky" | "simulator".
    pub provider: ProviderKind,
    /// High-frequency updates for flights users are watching: "adsbLol" | "none" (ignored with the simulator).
    pub watch_provider: WatchProviderKind,
    pub calls: Calls,
    pub max_tracked_flights: usize,
    pub stale_after_seconds: u64,
    pub watch_ttl_seconds: u64,
    pub trail: Trail,
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
    pub timeout_seconds: u64,
}

impl OpenSky {
    pub fn has_credentials(&self) -> bool {
        !self.client_id.is_empty() && !self.client_secret.is_empty()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdsbLol {
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    pub poll_interval_seconds: u64,
    pub timeout_seconds: u64,
    pub max_concurrent: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Simulator {
    pub airlines: Vec<String>,
    pub flights_per_airline: u32,
    pub tick_seconds: u64,
    pub seed: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trail {
    pub sample_seconds: u64,
    pub max_points: usize,
}

impl Config {
    pub fn load() -> Result<Self> {
        let path = std::env::var(ENV_CONFIG_PATH).unwrap_or_else(|_| DEFAULT_CONFIG_PATH.into());
        Self::load_from(Path::new(&path))
    }

    pub fn load_from(path: &Path) -> Result<Self> {
        let path = std::path::absolute(path)?;
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

    /// Non-fatal issues: mostly OpenSky rate-limit budgets.
    pub fn warnings(&self) -> Vec<String> {
        let mut w = Vec::new();
        let os = &self.tracking.calls.opensky;
        if self.tracking.provider == ProviderKind::OpenSky {
            // A global /states/all request costs 4 API credits.
            if !os.has_credentials() && os.poll_interval_seconds < 900 {
                w.push(format!(
                    "OpenSky without credentials allows ~400 credits/day (~100 global polls); pollIntervalSeconds={} will hit HTTP 429 — add clientId/clientSecret or use >= 900",
                    os.poll_interval_seconds
                ));
            } else if os.has_credentials() && os.poll_interval_seconds < 90 {
                w.push(format!(
                    "OpenSky accounts get ~4000 credits/day (~1000 global polls); pollIntervalSeconds={} will exhaust it — use >= 90",
                    os.poll_interval_seconds
                ));
            }
        }
        w
    }

    fn validate(&self) -> Result<()> {
        let t = &self.tracking;
        let required = [
            ("shared.postgres.host", &self.shared.postgres.host),
            ("shared.postgres.database", &self.shared.postgres.database),
            ("shared.redis.host", &self.shared.redis.host),
            ("shared.redis.password", &self.shared.redis.password),
            ("shared.internalToken", &self.shared.internal_token),
            ("tracking.listen", &t.listen),
            ("tracking.db.schema", &t.db.schema),
            ("tracking.db.user", &t.db.user),
            ("tracking.db.password", &t.db.password),
            ("tracking.calls.opensky.baseUrl", &t.calls.opensky.base_url),
            ("tracking.calls.adsbLol.baseUrl", &t.calls.adsb_lol.base_url),
        ];
        let mut errors: Vec<String> = required
            .iter()
            .filter_map(|(key, val)| match val.trim() {
                "" => Some(format!("{key} is required")),
                PLACEHOLDER => Some(format!("{key} is still {PLACEHOLDER:?} — run `npm run setup`")),
                _ => None,
            })
            .collect();

        if !(1..=5).contains(&t.max_tracked_flights) {
            errors.push("tracking.maxTrackedFlights must be between 1 and 5".into());
        }
        if t.stale_after_seconds < 30 {
            errors.push("tracking.staleAfterSeconds must be >= 30".into());
        }
        if t.watch_ttl_seconds < 10 {
            errors.push("tracking.watchTtlSeconds must be >= 10".into());
        }
        if !(10..=2000).contains(&t.trail.max_points) || t.trail.sample_seconds == 0 {
            errors.push("tracking.trail: maxPoints must be 10..=2000 and sampleSeconds > 0".into());
        }
        if t.calls.opensky.poll_interval_seconds < 10 || t.calls.adsb_lol.poll_interval_seconds < 1 {
            errors.push("poll intervals: opensky >= 10s, adsbLol >= 1s".into());
        }
        if t.calls.adsb_lol.max_concurrent == 0 {
            errors.push("tracking.calls.adsbLol.maxConcurrent must be > 0".into());
        }
        let sim = &t.calls.simulator;
        if t.provider == ProviderKind::Simulator
            && (sim.airlines.is_empty() || sim.flights_per_airline == 0 || sim.tick_seconds == 0)
        {
            errors.push("tracking.calls.simulator needs airlines, flightsPerAirline > 0 and tickSeconds > 0".into());
        }
        if self.is_production() && t.provider == ProviderKind::Simulator {
            errors.push("tracking.provider must not be \"simulator\" in production".into());
        }
        if !errors.is_empty() {
            bail!(errors.join("; "));
        }
        Ok(())
    }
}
