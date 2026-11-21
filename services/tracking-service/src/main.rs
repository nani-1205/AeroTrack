//! AeroTrack tracking-service: ingests live flight positions and serves airline/flight data.

mod catalogue;
mod config;
mod db;
mod geo;
mod http;
mod ingest;
mod live;
mod model;
mod providers;

use std::sync::Arc;

use anyhow::{Context, Result};
use metrics_exporter_prometheus::PrometheusBuilder;
use tokio::net::TcpListener;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use crate::config::ProviderKind;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    if let Err(err) = run().await {
        tracing::error!(error = format!("{err:#}"), "tracking-service stopped");
        std::process::exit(1);
    }
    Ok(())
}

async fn run() -> Result<()> {
    let cfg = Arc::new(config::Config::load()?);
    info!(path = %cfg.path.display(), env = %cfg.env, provider = ?cfg.tracking.provider, "config loaded");
    for w in cfg.warnings() {
        warn!("{w}");
    }

    let metrics = PrometheusBuilder::new().install_recorder().context("install prometheus recorder")?;

    let pool = db::connect(&cfg).await?;
    db::migrate(&pool).await?;
    catalogue::seed(&pool).await?;
    let catalogue = catalogue::load(&pool).await?;
    info!(airlines = catalogue.len(), "airline catalogue loaded");
    if cfg.tracking.provider == ProviderKind::Simulator {
        for code in &cfg.tracking.calls.simulator.airlines {
            if catalogue.get(&code.to_uppercase()).is_none() {
                warn!(airline = %code, "simulator airline is not in the catalogue — its flights will be ignored");
            }
        }
    }

    let r = &cfg.shared.redis;
    let redis = redis::Client::open(format!("redis://:{}@{}:{}/{}", r.password, r.host, r.port, r.db)).context("redis client")?;
    let redis = redis::aio::ConnectionManager::new(redis).await.context("connect redis")?;

    let live = live::LiveStore::new(redis.clone(), cfg.tracking.stale_after_seconds, cfg.tracking.trail.clone());
    let provider_name = match cfg.tracking.provider {
        ProviderKind::OpenSky => "opensky",
        ProviderKind::Simulator => "simulator",
    };
    let shared = Arc::new(ingest::Shared::new(catalogue, provider_name));
    ingest::spawn(cfg.clone(), pool.clone(), redis.clone(), live.clone(), shared.clone())?;

    let app = http::router(http::AppState { cfg: cfg.clone(), db: pool, redis, metrics, live, shared });
    let listener = TcpListener::bind(&cfg.tracking.listen)
        .await
        .with_context(|| format!("bind {}", cfg.tracking.listen))?;
    info!(addr = %cfg.tracking.listen, "listening");
    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await?;
    info!("shut down cleanly");
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    info!("shutting down");
}
