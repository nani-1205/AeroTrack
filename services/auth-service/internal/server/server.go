// Package server wires the HTTP routes and middleware of the auth-service.
//
// Every route except health, metrics and JWKS is reachable only through the gateway:
// requests must carry the shared internal token. Identity headers (x-user-id, x-user-role,
// x-session-id) are set by the gateway after JWT verification and are trusted only then.
package server

import (
	"context"
	"crypto/subtle"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"

	"aerotrack/auth-service/internal/config"
	"aerotrack/auth-service/internal/events"
	"aerotrack/auth-service/internal/github"
	"aerotrack/auth-service/internal/session"
	"aerotrack/auth-service/internal/store"
	"aerotrack/auth-service/internal/token"
)

var (
	httpRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "http_requests_total",
		Help: "HTTP requests handled, by route and status.",
	}, []string{"method", "route", "status"})
	httpDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "http_request_duration_seconds",
		Help:    "HTTP request latency, by route.",
		Buckets: prometheus.DefBuckets,
	}, []string{"method", "route"})
	logins = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "auth_logins_total",
		Help: "Login attempts by account kind and result.",
	}, []string{"kind", "result"})
)

type Deps struct {
	Cfg      *config.Config
	DB       *pgxpool.Pool
	Redis    *redis.Client
	Store    *store.Store
	Sessions *session.Store
	Tokens   *token.Issuer
	GitHub   *github.Client
	Events   *events.Publisher
	Log      *slog.Logger
}

type server struct {
	Deps
	now func() time.Time
}

// principal is the identity the gateway verified for this request.
type principal struct {
	ID        string
	SessionID string
}

func New(d Deps) http.Handler {
	s := &server{Deps: d, now: time.Now}
	registerSessionGauges(d.Sessions)

	mux := http.NewServeMux()
	// Open endpoints (health checks, scraping, key discovery).
	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "service": "auth"})
	})
	mux.HandleFunc("GET /health/ready", s.ready)
	mux.Handle("GET /metrics", promhttp.Handler())
	mux.HandleFunc("GET /.well-known/jwks.json", s.jwks)

	// User portal: GitHub SSO.
	mux.HandleFunc("GET /auth/github/login", s.internal(s.githubLogin))
	mux.HandleFunc("GET /auth/github/callback", s.internal(s.githubCallback))
	mux.HandleFunc("POST /auth/refresh", s.internal(s.userRefresh))
	mux.HandleFunc("POST /auth/logout", s.internal(s.userLogout))
	mux.HandleFunc("GET /account/me", s.internal(s.requireRole(token.RoleUser, s.userMe)))

	// Admin portal: username + password.
	mux.HandleFunc("POST /admin/auth/login", s.internal(s.adminLogin))
	mux.HandleFunc("POST /admin/auth/refresh", s.internal(s.adminRefresh))
	mux.HandleFunc("POST /admin/auth/logout", s.internal(s.adminLogout))
	mux.HandleFunc("GET /admin/account/me", s.internal(s.requireRole(token.RoleAdmin, s.adminMe)))
	mux.HandleFunc("POST /admin/account/password", s.internal(s.requireRole(token.RoleAdmin, s.adminChangePassword)))

	return instrument(mux)
}

func (s *server) ready(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	checks := map[string]string{"postgres": "ok", "redis": "ok"}
	status := http.StatusOK
	if err := s.DB.Ping(ctx); err != nil {
		checks["postgres"], status = err.Error(), http.StatusServiceUnavailable
	}
	if err := s.Redis.Ping(ctx).Err(); err != nil {
		checks["redis"], status = err.Error(), http.StatusServiceUnavailable
	}
	writeJSON(w, status, map[string]any{"service": "auth", "checks": checks})
}

func (s *server) jwks(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/jwk-set+json")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write(s.Tokens.JWKS())
}

// internal rejects requests that did not come through the gateway.
func (s *server) internal(next http.HandlerFunc) http.HandlerFunc {
	want := []byte(s.Cfg.Shared.InternalToken)
	return func(w http.ResponseWriter, r *http.Request) {
		got := []byte(r.Header.Get("X-Internal-Token"))
		if subtle.ConstantTimeCompare(got, want) != 1 {
			writeError(w, http.StatusUnauthorized, "unauthorized", "requests must come through the gateway")
			return
		}
		next(w, r)
	}
}

// requireRole checks the identity the gateway attached after verifying the JWT.
func (s *server) requireRole(role token.Role, next func(http.ResponseWriter, *http.Request, principal)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p := principal{ID: r.Header.Get("X-User-Id"), SessionID: r.Header.Get("X-Session-Id")}
		if p.ID == "" || r.Header.Get("X-User-Role") != string(role) {
			writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
			return
		}
		next(w, r, p)
	}
}

func registerSessionGauges(sessions *session.Store) {
	for _, kind := range []session.Kind{session.KindUser, session.KindAdmin} {
		// Register (not MustRegister): building the server twice (tests) must not panic.
		_ = prometheus.Register(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Name:        "auth_active_sessions",
			Help:        "Signed-in (non-expired) sessions by account kind.",
			ConstLabels: prometheus.Labels{"kind": string(kind)},
		}, func() float64 {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			n, err := sessions.CountActive(ctx, kind)
			if err != nil {
				return -1
			}
			return float64(n)
		}))
	}
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// instrument records Prometheus metrics per matched route pattern (bounded cardinality).
func instrument(next *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		route := r.Pattern
		if route == "" {
			route = "unmatched"
		}
		httpRequests.WithLabelValues(r.Method, route, strconv.Itoa(rec.status)).Inc()
		httpDuration.WithLabelValues(r.Method, route).Observe(time.Since(start).Seconds())
	})
}
