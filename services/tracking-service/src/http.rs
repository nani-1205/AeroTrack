//! HTTP routes: health, readiness and Prometheus metrics.

use std::time::{Duration, Instant};

use axum::extract::{MatchedPath, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use metrics_exporter_prometheus::PrometheusHandle;
use redis::aio::ConnectionManager;
use serde_json::json;
use sqlx::PgPool;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub redis: ConnectionManager,
    pub metrics: PrometheusHandle,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health/live", get(|| async { Json(json!({ "status": "ok", "service": "tracking" })) }))
        .route("/health/ready", get(ready))
        .route("/metrics", get(|State(s): State<AppState>| async move { s.metrics.render() }))
        .route_layer(middleware::from_fn(track_metrics))
        .with_state(state)
}

async fn ready(State(s): State<AppState>) -> impl IntoResponse {
    let pg = tokio::time::timeout(Duration::from_secs(2), sqlx::query("SELECT 1").execute(&s.db)).await;
    let pg_status = match pg {
        Ok(Ok(_)) => "ok".to_string(),
        Ok(Err(e)) => e.to_string(),
        Err(_) => "timeout".to_string(),
    };

    let mut conn = s.redis.clone();
    let rd = tokio::time::timeout(
        Duration::from_secs(2),
        redis::cmd("PING").query_async::<String>(&mut conn),
    )
    .await;
    let redis_status = match rd {
        Ok(Ok(_)) => "ok".to_string(),
        Ok(Err(e)) => e.to_string(),
        Err(_) => "timeout".to_string(),
    };

    let status = if pg_status == "ok" && redis_status == "ok" {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(json!({ "service": "tracking", "checks": { "postgres": pg_status, "redis": redis_status } })),
    )
}

/// Records request count + latency labelled by the matched route template (bounded cardinality).
async fn track_metrics(req: Request, next: Next) -> Response {
    let start = Instant::now();
    let route = req
        .extensions()
        .get::<MatchedPath>()
        .map(|p| p.as_str().to_owned())
        .unwrap_or_else(|| "unmatched".into());
    let method = req.method().to_string();

    let response = next.run(req).await;

    let status = response.status().as_u16().to_string();
    let labels = [("method", method), ("route", route), ("status", status)];
    metrics::counter!("http_requests_total", &labels).increment(1);
    metrics::histogram!("http_request_duration_seconds", &labels[..2]).record(start.elapsed().as_secs_f64());
    response
}
