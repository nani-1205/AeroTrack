//! Flight data providers.
//!
//! * A **global** provider (OpenSky or the simulator) delivers full snapshots and decides which
//!   flights are active.
//! * The **watch** provider (adsb.lol) refreshes just the flights users are watching, every few
//!   seconds, so the live map moves smoothly even when the global feed polls every 90 s.

pub mod adsblol;
pub mod opensky;
pub mod simulator;

use anyhow::Result;

use crate::model::Observation;

/// Error carrying an optional server-requested back-off (HTTP 429).
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("rate limited by provider (retry after {0:?}s)")]
    RateLimited(Option<u64>),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

pub enum GlobalProvider {
    OpenSky(opensky::OpenSky),
    Simulator(simulator::Simulator),
}

impl GlobalProvider {
    pub fn name(&self) -> &'static str {
        match self {
            Self::OpenSky(_) => "opensky",
            Self::Simulator(_) => "simulator",
        }
    }

    /// Full snapshot of all currently visible aircraft.
    pub async fn snapshot(&mut self) -> Result<Vec<Observation>, ProviderError> {
        match self {
            Self::OpenSky(p) => p.snapshot().await,
            Self::Simulator(p) => Ok(p.snapshot()),
        }
    }
}

pub(crate) fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

pub(crate) fn http_client(timeout_seconds: u64) -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_seconds.max(1)))
        .user_agent("AeroTrack-tracking-service")
        .build()?)
}
