//! Background ingestion: global snapshots, watched-flight refreshes, catalogue reloads.
//! Only the instance holding the Redis leader lock ingests, so the service can scale out.

use std::sync::Arc;
use std::time::Duration;

use rand::Rng;
use redis::aio::ConnectionManager;
use serde::Serialize;
use sqlx::PgPool;
use tokio::sync::{Mutex, RwLock};
use tracing::{debug, info, warn};

use crate::config::{Config, ProviderKind, WatchProviderKind};
use crate::live::{IngestState, LiveStore};
use crate::model::Catalogue;
use crate::providers::{GlobalProvider, ProviderError, adsblol::AdsbLol, opensky::OpenSky, simulator::Simulator, unix_now};
use crate::catalogue;

const LEADER_KEY: &str = "trk:ingest:leader";
const MAX_BACKOFF: Duration = Duration::from_secs(600);
const CATALOGUE_REFRESH: Duration = Duration::from_secs(600);
/// Upper bound of watched flights refreshed per cycle (protects the open API).
const MAX_WATCHED_PER_CYCLE: usize = 100;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHealth {
    pub provider: &'static str,
    pub is_leader: bool,
    pub last_success: Option<i64>,
    pub last_error: Option<String>,
    pub last_count: usize,
}

/// State shared between the HTTP handlers and the ingest loops.
pub struct Shared {
    pub catalogue: RwLock<Arc<Catalogue>>,
    pub health: Mutex<ProviderHealth>,
    pub ingest: Mutex<IngestState>,
}

impl Shared {
    pub fn new(catalogue: Catalogue, provider: &'static str) -> Self {
        Self {
            catalogue: RwLock::new(Arc::new(catalogue)),
            health: Mutex::new(ProviderHealth { provider, ..Default::default() }),
            ingest: Mutex::new(IngestState::default()),
        }
    }

    pub async fn catalogue(&self) -> Arc<Catalogue> {
        self.catalogue.read().await.clone()
    }
}

/// Redis lock: acquire if free, extend if ours. Atomic via Lua.
struct Leader {
    redis: ConnectionManager,
    id: String,
    ttl_ms: u64,
    script: redis::Script,
}

impl Leader {
    fn new(redis: ConnectionManager, ttl: Duration) -> Self {
        let id = format!("{:016x}", rand::rng().random::<u64>());
        let script = redis::Script::new(
            r"local v = redis.call('GET', KEYS[1])
              if v == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[2]) return 1 end
              if not v then redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1 end
              return 0",
        );
        Self { redis, id, ttl_ms: ttl.as_millis() as u64, script }
    }

    async fn ensure(&self) -> bool {
        let mut conn = self.redis.clone();
        match self.script.key(LEADER_KEY).arg(&self.id).arg(self.ttl_ms).invoke_async::<i32>(&mut conn).await {
            Ok(v) => v == 1,
            Err(e) => {
                warn!(error = %e, "leader lock check failed");
                false
            }
        }
    }
}

pub fn spawn(cfg: Arc<Config>, pool: PgPool, redis: ConnectionManager, live: LiveStore, shared: Arc<Shared>) -> anyhow::Result<()> {
    let t = &cfg.tracking;
    let (provider, interval) = match t.provider {
        ProviderKind::OpenSky => (
            GlobalProvider::OpenSky(OpenSky::new(t.calls.opensky.clone())?),
            Duration::from_secs(t.calls.opensky.poll_interval_seconds),
        ),
        ProviderKind::Simulator => (
            GlobalProvider::Simulator(Simulator::new(&t.calls.simulator)),
            Duration::from_secs(t.calls.simulator.tick_seconds),
        ),
    };
    let leader = Arc::new(Leader::new(redis, (interval * 3).max(Duration::from_secs(30))));
    info!(provider = provider.name(), interval_s = interval.as_secs(), instance = %leader.id, "ingestion starting");

    tokio::spawn(global_loop(provider, interval, live.clone(), shared.clone(), leader.clone()));

    if t.provider == ProviderKind::OpenSky && t.watch_provider == WatchProviderKind::AdsbLol {
        let watch = AdsbLol::new(t.calls.adsb_lol.clone())?;
        let every = Duration::from_secs(t.calls.adsb_lol.poll_interval_seconds);
        tokio::spawn(watch_loop(watch, every, live, shared.clone(), leader));
    }
    tokio::spawn(catalogue_loop(pool, shared));
    Ok(())
}

async fn global_loop(mut provider: GlobalProvider, interval: Duration, live: LiveStore, shared: Arc<Shared>, leader: Arc<Leader>) {
    let mut failures: u32 = 0;
    loop {
        let mut wait = interval;
        let leading = leader.ensure().await;
        shared.health.lock().await.is_leader = leading;
        if leading {
            let started = std::time::Instant::now();
            let result = provider.snapshot().await;
            let label = provider.name();
            match result {
                Ok(observations) => {
                    let total = observations.len();
                    let catalogue = shared.catalogue().await;
                    let mut state = shared.ingest.lock().await;
                    match live.apply_snapshot(&mut state, &catalogue, observations, unix_now()).await {
                        Ok(report) => {
                            failures = 0;
                            metrics::counter!("tracking_provider_polls_total", "provider" => label, "result" => "ok").increment(1);
                            debug!(aircraft = total, ?report, "snapshot applied");
                            let mut h = shared.health.lock().await;
                            h.last_success = Some(unix_now());
                            h.last_error = None;
                            h.last_count = report.active;
                        }
                        Err(e) => {
                            failures += 1;
                            warn!(error = format!("{e:#}"), "applying snapshot failed");
                            shared.health.lock().await.last_error = Some(format!("{e:#}"));
                        }
                    }
                }
                Err(e) => {
                    failures += 1;
                    let result = if matches!(e, ProviderError::RateLimited(_)) { "rate_limited" } else { "error" };
                    metrics::counter!("tracking_provider_polls_total", "provider" => label, "result" => result).increment(1);
                    warn!(provider = label, error = %e, failures, "provider poll failed");
                    shared.health.lock().await.last_error = Some(e.to_string());
                    wait = match e {
                        ProviderError::RateLimited(Some(secs)) => Duration::from_secs(secs).min(MAX_BACKOFF),
                        _ => backoff(interval, failures),
                    };
                }
            }
            metrics::histogram!("tracking_poll_duration_seconds", "provider" => label).record(started.elapsed().as_secs_f64());
        }
        tokio::time::sleep(wait).await;
    }
}

async fn watch_loop(provider: AdsbLol, every: Duration, live: LiveStore, shared: Arc<Shared>, leader: Arc<Leader>) {
    let mut failures: u32 = 0;
    loop {
        let mut wait = every;
        if leader.ensure().await {
            match live.watched(unix_now(), MAX_WATCHED_PER_CYCLE).await {
                Ok(ids) if !ids.is_empty() => match provider.lookup_many(ids).await {
                    Ok(observations) => {
                        failures = 0;
                        let catalogue = shared.catalogue().await;
                        let mut state = shared.ingest.lock().await;
                        match live.apply_updates(&mut state, &catalogue, observations, unix_now()).await {
                            Ok(n) => {
                                metrics::counter!("tracking_provider_polls_total", "provider" => "adsbLol", "result" => "ok").increment(1);
                                debug!(updated = n, "watched flights refreshed");
                            }
                            Err(e) => warn!(error = format!("{e:#}"), "applying watch updates failed"),
                        }
                    }
                    Err(e) => {
                        failures += 1;
                        metrics::counter!("tracking_provider_polls_total", "provider" => "adsbLol", "result" => "error").increment(1);
                        warn!(error = %e, failures, "adsb.lol refresh failed");
                        wait = backoff(every, failures);
                    }
                },
                Ok(_) => {}
                Err(e) => warn!(error = format!("{e:#}"), "reading watched flights failed"),
            }
        }
        tokio::time::sleep(wait).await;
    }
}

async fn catalogue_loop(pool: PgPool, shared: Arc<Shared>) {
    loop {
        tokio::time::sleep(CATALOGUE_REFRESH).await;
        match catalogue::load(&pool).await {
            Ok(c) => *shared.catalogue.write().await = Arc::new(c),
            Err(e) => warn!(error = format!("{e:#}"), "catalogue refresh failed"),
        }
    }
}

fn backoff(base: Duration, failures: u32) -> Duration {
    (base * 2u32.saturating_pow(failures.min(10))).min(MAX_BACKOFF)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_and_caps() {
        let base = Duration::from_secs(90);
        assert_eq!(backoff(base, 1), Duration::from_secs(180));
        assert_eq!(backoff(base, 2), Duration::from_secs(360));
        assert_eq!(backoff(base, 9), MAX_BACKOFF);
    }
}
