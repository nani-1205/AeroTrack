//! HTTP API (reached through the gateway at /api/airlines and /api/flights) plus health/metrics.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{MatchedPath, Path, Query, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use metrics_exporter_prometheus::PrometheusHandle;
use redis::aio::ConnectionManager;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgPool;

use crate::config::Config;
use crate::ingest::Shared;
use crate::live::{self, LiveStore, SelectionError};
use crate::model::{Airline, Flight};
use crate::providers::unix_now;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub db: PgPool,
    pub redis: ConnectionManager,
    pub metrics: PrometheusHandle,
    pub live: LiveStore,
    pub shared: Arc<Shared>,
}

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/airlines", get(list_airlines))
        .route("/airlines/{icao}", get(get_airline))
        .route("/airlines/{icao}/flights", get(airline_flights))
        .route("/flights/watch", post(watch_flights))
        .route("/flights/{icao24}", get(get_flight))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_internal));

    Router::new()
        .route("/health/live", get(|| async { Json(json!({ "status": "ok", "service": "tracking" })) }))
        .route("/health/ready", get(ready))
        .route("/metrics", get(|State(s): State<AppState>| async move { s.metrics.render() }))
        .merge(api)
        .route_layer(middleware::from_fn(track_metrics))
        .with_state(state)
}

// ------------------------------------------------------------------ errors

pub struct ApiError(StatusCode, &'static str, String, Option<(&'static str, serde_json::Value)>);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = json!({ "error": self.1, "message": self.2 });
        if let Some((key, value)) = self.3 {
            body[key] = value;
        }
        (self.0, Json(body)).into_response()
    }
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self(status, code, message.into(), None)
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!(error = format!("{e:#}"), "request failed");
        ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable", "live data temporarily unavailable")
    }
}

impl From<redis::RedisError> for ApiError {
    fn from(e: redis::RedisError) -> Self {
        anyhow::Error::from(e).into()
    }
}

fn not_found(what: &str) -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "not_found", format!("{what} not found"))
}

type ApiResult<T> = Result<Json<T>, ApiError>;

// --------------------------------------------------------------- middleware

async fn require_internal(State(s): State<AppState>, req: Request, next: Next) -> Response {
    let ok = req
        .headers()
        .get("x-internal-token")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|got| constant_time_eq(got.as_bytes(), s.cfg.shared.internal_token.as_bytes()));
    if !ok {
        return ApiError::new(StatusCode::UNAUTHORIZED, "unauthorized", "requests must come through the gateway").into_response();
    }
    next.run(req).await
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Records request count + latency labelled by the matched route template (bounded cardinality).
async fn track_metrics(req: Request, next: Next) -> Response {
    let start = Instant::now();
    let route = req.extensions().get::<MatchedPath>().map(|p| p.as_str().to_owned()).unwrap_or_else(|| "unmatched".into());
    let method = req.method().to_string();
    let response = next.run(req).await;
    let labels = [("method", method), ("route", route), ("status", response.status().as_u16().to_string())];
    metrics::counter!("http_requests_total", &labels).increment(1);
    metrics::histogram!("http_request_duration_seconds", &labels[..2]).record(start.elapsed().as_secs_f64());
    response
}

// ------------------------------------------------------------------ health

async fn ready(State(s): State<AppState>) -> impl IntoResponse {
    let pg = match tokio::time::timeout(Duration::from_secs(2), sqlx::query("SELECT 1").execute(&s.db)).await {
        Ok(Ok(_)) => "ok".to_string(),
        Ok(Err(e)) => e.to_string(),
        Err(_) => "timeout".to_string(),
    };
    let mut conn = s.redis.clone();
    let rd = match tokio::time::timeout(Duration::from_secs(2), redis::cmd("PING").query_async::<String>(&mut conn)).await {
        Ok(Ok(_)) => "ok".to_string(),
        Ok(Err(e)) => e.to_string(),
        Err(_) => "timeout".to_string(),
    };
    // The external feed is reported but never fails readiness: the API keeps serving cached state.
    let provider = s.shared.health.lock().await.clone();
    let status = if pg == "ok" && rd == "ok" { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
    (status, Json(json!({ "service": "tracking", "checks": { "postgres": pg, "redis": rd }, "provider": provider })))
}

// ---------------------------------------------------------------- airlines

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AirlineView {
    #[serde(flatten)]
    airline: Airline,
    active_flights: u64,
}

#[derive(Deserialize)]
struct ListQuery {
    search: Option<String>,
    limit: Option<usize>,
}

/// Without `search`: airlines that currently have active flights, busiest first.
/// With `search`: catalogue matches (by ICAO, IATA or name) with their live counts.
async fn list_airlines(State(s): State<AppState>, Query(q): Query<ListQuery>) -> ApiResult<serde_json::Value> {
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let catalogue = s.shared.catalogue().await;
    let airlines: Vec<AirlineView> = match q.search.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        Some(query) => {
            let hits = catalogue.search(query, limit);
            let codes: Vec<String> = hits.iter().map(|(_, a)| a.icao.clone()).collect();
            let counts = s.live.counts_for(&codes).await?;
            let mut ranked: Vec<(u8, AirlineView)> = hits
                .into_iter()
                .zip(counts)
                .map(|((rank, a), n)| (rank, AirlineView { airline: a.clone(), active_flights: n }))
                .collect();
            // Best match first; among equal matches, airlines with live flights first.
            ranked.sort_by(|(ra, a), (rb, b)| {
                ra.cmp(rb).then(b.active_flights.cmp(&a.active_flights)).then_with(|| a.airline.name.cmp(&b.airline.name))
            });
            ranked.into_iter().map(|(_, v)| v).collect()
        }
        None => s
            .live
            .active_counts(limit)
            .await?
            .into_iter()
            .filter_map(|(icao, n)| catalogue.get(&icao).map(|a| AirlineView { airline: a.clone(), active_flights: n }))
            .collect(),
    };
    Ok(Json(json!({ "airlines": airlines, "total": airlines.len() })))
}

async fn get_airline(State(s): State<AppState>, Path(icao): Path<String>) -> ApiResult<AirlineView> {
    let icao = icao.to_uppercase();
    let airline = s.shared.catalogue().await.get(&icao).cloned().ok_or_else(|| not_found("airline"))?;
    let active_flights = s.live.counts_for(std::slice::from_ref(&icao)).await?.first().copied().unwrap_or(0);
    Ok(Json(AirlineView { airline, active_flights }))
}

async fn airline_flights(State(s): State<AppState>, Path(icao): Path<String>) -> ApiResult<serde_json::Value> {
    let icao = icao.to_uppercase();
    let airline = s.shared.catalogue().await.get(&icao).cloned().ok_or_else(|| not_found("airline"))?;
    let flights = s.live.airline_flights(&icao).await?;
    Ok(Json(json!({ "airline": AirlineView { airline, active_flights: flights.len() as u64 }, "flights": flights })))
}

// ----------------------------------------------------------------- flights

#[derive(Deserialize)]
struct FlightQuery {
    #[serde(default)]
    trail: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FlightDetail {
    flight: Flight,
    airline: Option<Airline>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trail: Option<Vec<[f64; 4]>>,
}

async fn get_flight(State(s): State<AppState>, Path(icao24): Path<String>, Query(q): Query<FlightQuery>) -> ApiResult<FlightDetail> {
    let flight = s.live.flight(&icao24).await?.ok_or_else(|| not_found("active flight"))?;
    let airline = s.shared.catalogue().await.get(&flight.airline_icao).cloned();
    let trail = if q.trail { Some(s.live.trail(&flight.icao24).await?) } else { None };
    Ok(Json(FlightDetail { flight, airline, trail }))
}

#[derive(Deserialize)]
struct WatchRequest {
    icao24: Vec<String>,
}

/// Validates a selection (1–maxTrackedFlights flights, one airline) and marks the flights as
/// watched so the watch provider refreshes them every few seconds. Call again before
/// `watchTtlSeconds` elapses to keep watching. Returns the current state of the flights.
async fn watch_flights(State(s): State<AppState>, Json(req): Json<WatchRequest>) -> ApiResult<serde_json::Value> {
    let ids = live::normalize_ids(&req.icao24);
    let max = s.cfg.tracking.max_tracked_flights;
    if ids.is_empty() || ids.len() > max {
        return Err(selection_error(SelectionError::Count { max, got: ids.len() }));
    }
    let found = s.live.flights(&ids).await?;
    let airline_icao = live::validate_selection(&ids, max, &found).map_err(selection_error)?;
    let ttl = s.cfg.tracking.watch_ttl_seconds;
    s.live.watch(&ids, ttl, unix_now()).await?;
    let airline = s.shared.catalogue().await.get(&airline_icao).cloned();
    let flights: Vec<Flight> = found.into_iter().flatten().collect();
    Ok(Json(json!({ "airline": airline, "flights": flights, "watchTtlSeconds": ttl })))
}

fn selection_error(e: SelectionError) -> ApiError {
    match e {
        SelectionError::Count { max, got } => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_selection",
            format!("select between 1 and {max} flights (got {got})"),
        ),
        SelectionError::NotActive(ids) => {
            ApiError(StatusCode::NOT_FOUND, "not_active", format!("not active any more: {}", ids.join(", ")), Some(("inactive", json!(ids))))
        }
        SelectionError::MixedAirlines(codes) => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "mixed_airlines",
            format!("all selected flights must belong to the same airline (got {})", codes.join(", ")),
        ),
    }
}

#[cfg(test)]
mod tests {
    //! Integration tests: real Postgres (tracking schema) + Redis DB 15, simulated flights.
    //! Skipped when config/services.json or the databases are unavailable.
    use super::*;
    use crate::config::Simulator as SimCfg;
    use crate::providers::simulator::Simulator;
    use crate::{catalogue, db};
    use axum::body::{Body, to_bytes};
    use axum::http::Request as HttpRequest;
    use futures_util::StreamExt;
    use metrics_exporter_prometheus::PrometheusBuilder;
    use tower::ServiceExt;

    /// The integration tests share Redis DB 15, so they must not run concurrently.
    static SERIAL: std::sync::LazyLock<tokio::sync::Mutex<()>> = std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

    struct Harness {
        app: Router,
        state: AppState,
        token: String,
        sim_ids: Vec<(String, String)>, // (icao24, airline)
        client: redis::Client,
        _serial: tokio::sync::MutexGuard<'static, ()>,
    }

    async fn harness() -> Option<Harness> {
        let serial = SERIAL.lock().await;
        let Ok(mut cfg) = Config::load_from(std::path::Path::new("../../config/services.json")) else {
            eprintln!("skipped: config/services.json unavailable");
            return None;
        };
        cfg.shared.postgres.startup_retries = 1;
        cfg.shared.redis.db = 15;
        let pool = match db::connect(&cfg).await {
            Ok(p) => p,
            Err(e) => {
                eprintln!("skipped: postgres unavailable: {e:#}");
                return None;
            }
        };
        db::migrate(&pool).await.unwrap();
        catalogue::seed(&pool).await.unwrap();
        let cat = catalogue::load(&pool).await.unwrap();

        let r = &cfg.shared.redis;
        let client = redis::Client::open(format!("redis://:{}@{}:{}/15", r.password, r.host, r.port)).unwrap();
        let Ok(redis) = ConnectionManager::new(client.clone()).await else {
            eprintln!("skipped: redis unavailable");
            return None;
        };
        let mut conn = redis.clone();
        redis::cmd("FLUSHDB").query_async::<()>(&mut conn).await.unwrap();

        let live = LiveStore::new(redis.clone(), cfg.tracking.stale_after_seconds, cfg.tracking.trail.clone());
        let shared = Arc::new(Shared::new(cat, "simulator"));
        let metrics = PrometheusBuilder::new().build_recorder().handle();
        let token = cfg.shared.internal_token.clone();
        let state = AppState { cfg: Arc::new(cfg), db: pool, redis, metrics, live, shared };
        Some(Harness { app: router(state.clone()), state, token, sim_ids: vec![], client, _serial: serial })
    }

    impl Harness {
        async fn ingest_simulated(&mut self, now: i64) {
            let mut sim = Simulator::new(&SimCfg { airlines: vec!["AIC".into(), "BAW".into()], flights_per_airline: 3, tick_seconds: 2, seed: 9 });
            let obs = sim.observations(now);
            self.sim_ids = obs.iter().map(|o| (o.icao24.clone(), o.callsign.clone().unwrap()[..3].to_string())).collect();
            let cat = self.state.shared.catalogue().await;
            let mut st = self.state.shared.ingest.lock().await;
            self.state.live.apply_snapshot(&mut st, &cat, obs, now).await.unwrap();
        }

        fn ids_of(&self, airline: &str) -> Vec<String> {
            self.sim_ids.iter().filter(|(_, a)| a == airline).map(|(id, _)| id.clone()).collect()
        }

        async fn call(&self, method: &str, uri: &str, body: Option<serde_json::Value>, with_token: bool) -> (StatusCode, serde_json::Value) {
            let mut req = HttpRequest::builder().method(method).uri(uri).header("content-type", "application/json");
            if with_token {
                req = req.header("x-internal-token", &self.token);
            }
            let req = req.body(body.map(|b| Body::from(b.to_string())).unwrap_or_default()).unwrap();
            let res = self.app.clone().oneshot(req).await.unwrap();
            let status = res.status();
            let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
            (status, serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null))
        }
    }

    #[tokio::test]
    async fn airlines_flights_watch_and_expiry() {
        let Some(mut h) = harness().await else { return };
        let mut pubsub = h.client.get_async_pubsub().await.unwrap();
        pubsub.subscribe(live::channel("AIC")).await.unwrap();

        let now = unix_now();
        h.ingest_simulated(now).await;

        // A position batch was published for the airline.
        let msg = tokio::time::timeout(Duration::from_secs(3), pubsub.on_message().next()).await.unwrap().unwrap();
        let batch: live::PositionBatch = serde_json::from_str(&msg.get_payload::<String>().unwrap()).unwrap();
        assert_eq!((batch.airline.as_str(), batch.flights.len()), ("AIC", 3));

        let (status, _) = h.call("GET", "/airlines", None, false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "internal token required");

        let (status, body) = h.call("GET", "/airlines", None, true).await;
        assert_eq!(status, StatusCode::OK);
        let list = body["airlines"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert!(list.iter().all(|a| a["activeFlights"] == 3), "{body}");
        assert!(list.iter().any(|a| a["icao"] == "AIC" && a["name"] == "Air India Limited"));

        let (_, body) = h.call("GET", "/airlines?search=air%20india", None, true).await;
        assert_eq!(body["airlines"][0]["icao"], "AIC");
        assert_eq!(body["airlines"][0]["activeFlights"], 3);

        let (status, body) = h.call("GET", "/airlines/aic/flights", None, true).await;
        assert_eq!(status, StatusCode::OK);
        let flights = body["flights"].as_array().unwrap();
        assert_eq!(flights.len(), 3);
        assert!(flights.iter().all(|f| f["callsign"].as_str().unwrap().starts_with("AIC") && f["route"]["origin"].is_string()));

        // Seed codes are always three letters, so "X1X" can never exist.
        let (status, _) = h.call("GET", "/airlines/X1X/flights", None, true).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let aic = h.ids_of("AIC");
        let baw = h.ids_of("BAW");
        let (status, body) = h.call("GET", &format!("/flights/{}?trail=true", aic[0]), None, true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["airline"]["icao"], "AIC");
        assert_eq!(body["trail"].as_array().unwrap().len(), 1);

        // Selection rules: 1–5 flights, one airline, all active.
        let (status, body) = h.call("POST", "/flights/watch", Some(json!({ "icao24": aic[..2] })), true).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["flights"].as_array().unwrap().len(), 2);
        assert_eq!(h.state.live.watched(unix_now(), 10).await.unwrap().len(), 2);

        let (status, body) = h.call("POST", "/flights/watch", Some(json!({ "icao24": [aic[0], baw[0]] })), true).await;
        assert_eq!((status, body["error"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("mixed_airlines")));

        let six: Vec<_> = aic.iter().chain(&baw).cloned().collect();
        let (status, body) = h.call("POST", "/flights/watch", Some(json!({ "icao24": six })), true).await;
        assert_eq!((status, body["error"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid_selection")));

        let (status, body) = h.call("POST", "/flights/watch", Some(json!({ "icao24": [] })), true).await;
        assert_eq!((status, body["error"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid_selection")));

        let (status, body) = h.call("POST", "/flights/watch", Some(json!({ "icao24": ["ffffff"] })), true).await;
        assert_eq!((status, body["error"].as_str()), (StatusCode::NOT_FOUND, Some("not_active")));
        assert_eq!(body["inactive"], json!(["ffffff"]), "lists which flights are gone so the gateway can drop just those");

        // Nothing seen for longer than staleAfterSeconds → flights and counts disappear.
        let later = now + h.state.cfg.tracking.stale_after_seconds as i64 + 1;
        let cat = h.state.shared.catalogue().await;
        let report = {
            let mut st = h.state.shared.ingest.lock().await;
            h.state.live.apply_snapshot(&mut st, &cat, vec![], later).await.unwrap()
        };
        assert_eq!((report.removed, report.active), (6, 0));
        let (_, body) = h.call("GET", "/airlines/AIC/flights", None, true).await;
        assert!(body["flights"].as_array().unwrap().is_empty());
        let (_, body) = h.call("GET", "/airlines", None, true).await;
        assert!(body["airlines"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn watch_updates_merge_into_active_flights_only() {
        let Some(mut h) = harness().await else { return };
        let now = unix_now();
        h.ingest_simulated(now).await;
        let id = h.ids_of("AIC")[0].clone();
        let before = h.state.live.flight(&id).await.unwrap().unwrap();

        // adsb.lol-style update: newer, no callsign/route, with registration.
        let update = crate::model::Observation {
            icao24: id.to_uppercase(), callsign: None, origin_country: None, lat: before.lat + 0.1, lon: before.lon,
            altitude_m: Some(9_000.0), ground_speed_ms: Some(240.0), heading_deg: Some(10.0), vertical_rate_ms: Some(0.0),
            on_ground: false, last_contact: now + 5, source: crate::model::Source::AdsbLol,
            registration: Some("VT-TEST".into()), aircraft_type: None, route: None,
        };
        let mut stranger = update.clone();
        stranger.icao24 = "abcdef".into();
        stranger.callsign = Some("AIC999".into());

        let cat = h.state.shared.catalogue().await;
        let n = {
            let mut st = h.state.shared.ingest.lock().await;
            h.state.live.apply_updates(&mut st, &cat, vec![update, stranger], now + 5).await.unwrap()
        };
        assert_eq!(n, 1, "unknown aircraft are not added by the watch provider");

        let after = h.state.live.flight(&id).await.unwrap().unwrap();
        assert_eq!(after.callsign, before.callsign, "callsign kept from the active record");
        assert_eq!(after.route, before.route, "route kept from the active record");
        assert_eq!(after.first_seen, before.first_seen);
        assert_eq!(after.registration.as_deref(), Some("VT-TEST"));
        assert!((after.lat - (before.lat + 0.1)).abs() < 1e-9);
        assert!(h.state.live.flight("abcdef").await.unwrap().is_none());
    }
}
