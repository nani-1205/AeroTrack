//! AeroTrack tracking-service: ingests live flight positions and serves airline/flight data.

mod config;
mod db;
mod http;

use anyhow::{Context, Result};
use metrics_exporter_prometheus::PrometheusBuilder;
use tokio::net::TcpListener;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

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
    let cfg = config::Config::load()?;
    info!(path = %cfg.path.display(), env = %cfg.env, provider = %cfg.tracking.provider, "config loaded");
    for w in cfg.warnings() {
        warn!("{w}");
    }

    let metrics = PrometheusBuilder::new()
        .install_recorder()
        .context("install prometheus recorder")?;

    let pool = db::connect(&cfg).await?;
    db::migrate(&pool).await?;

    let r = &cfg.shared.redis;
    let redis_url = format!("redis://:{}@{}:{}/{}", r.password, r.host, r.port, r.db);
    let redis = redis::Client::open(redis_url).context("redis client")?;
    let redis = redis::aio::ConnectionManager::new(redis).await.context("connect redis")?;

    let app = http::router(http::AppState { db: pool, redis, metrics });
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
