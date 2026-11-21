//! PostgreSQL connection (wait-until-available) and startup migrations.
//!
//! Migration policy: only pending migrations are applied, under sqlx's advisory lock.
//! A changed (checksum mismatch), missing or partially-applied migration aborts startup —
//! nothing is ever forced or reset.

use std::str::FromStr;
use std::time::Duration;

use anyhow::{Context, Result};
use sqlx::PgPool;
use sqlx::migrate::Migrator;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use tracing::{info, warn};

use crate::config::Config;

static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

pub async fn connect(cfg: &Config) -> Result<PgPool> {
    let pg = &cfg.shared.postgres;
    let creds = &cfg.tracking.db;
    let options = PgConnectOptions::new()
        .host(&pg.host)
        .port(pg.port)
        .database(&pg.database)
        .username(&creds.user)
        .password(&creds.password)
        .ssl_mode(PgSslMode::from_str(&pg.sslmode).context("invalid shared.postgres.sslmode")?)
        .application_name("tracking-service")
        .options([("search_path", creds.schema.as_str())]);

    let retries = pg.startup_retries.max(1);
    let mut backoff = Duration::from_secs(1);
    for attempt in 1..=retries {
        let result = PgPoolOptions::new()
            .max_connections(10)
            .acquire_timeout(Duration::from_secs(pg.connect_timeout_seconds.max(1)))
            .connect_with(options.clone())
            .await;
        match result {
            Ok(pool) => {
                info!(host = %pg.host, schema = %creds.schema, attempt, "postgres is available");
                return Ok(pool);
            }
            Err(err) if attempt < retries => {
                warn!(attempt, of = retries, error = %err, "waiting for postgres");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(5));
            }
            Err(err) => {
                return Err(err).context(format!("postgres not available after {attempt} attempts"));
            }
        }
    }
    unreachable!("retry loop always returns")
}

pub async fn migrate(pool: &PgPool) -> Result<()> {
    let applied_before: i64 = applied_count(pool).await?;
    MIGRATOR
        .run(pool)
        .await
        .context("migration failed (nothing forced — fix the migration files, do not edit applied ones)")?;
    let applied_after = applied_count(pool).await?;
    let newly = applied_after - applied_before;
    if newly == 0 {
        info!(applied = applied_after, "schema up to date — no pending migrations");
    } else {
        info!(newly_applied = newly, total = applied_after, "applied pending migrations");
    }
    Ok(())
}

async fn applied_count(pool: &PgPool) -> Result<i64> {
    // The bookkeeping table does not exist before the very first run.
    let exists: bool = sqlx::query_scalar("SELECT to_regclass('_sqlx_migrations') IS NOT NULL")
        .fetch_one(pool)
        .await?;
    if !exists {
        return Ok(0);
    }
    Ok(sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations WHERE success")
        .fetch_one(pool)
        .await?)
}
