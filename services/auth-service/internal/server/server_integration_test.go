package server

// Integration tests against the local Postgres (docker-compose) and Redis DB 15.
// They are skipped automatically when config/services.json or the databases are unavailable.
// Rows created here use unique names and are deleted afterwards.

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"aerotrack/auth-service/internal/config"
	"aerotrack/auth-service/internal/database"
	"aerotrack/auth-service/internal/events"
	"aerotrack/auth-service/internal/github"
	"aerotrack/auth-service/internal/password"
	"aerotrack/auth-service/internal/session"
	"aerotrack/auth-service/internal/store"
	"aerotrack/auth-service/internal/token"
)

const testRedisDB = 15

type harness struct {
	t      *testing.T
	cfg    *config.Config
	db     *pgxpool.Pool
	store  *store.Store
	tokens *token.Issuer
	srv    *httptest.Server
	client *http.Client
}

func newHarness(t *testing.T, githubProfileID int64) *harness {
	t.Helper()
	path, _ := filepath.Abs("../../../../config/services.json")
	t.Setenv(config.EnvConfigPath, path)
	cfg, err := config.Load()
	if err != nil {
		t.Skipf("integration config unavailable: %v", err)
	}
	cfg.Shared.Postgres.StartupRetries = 1
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	db, err := database.Connect(ctx, cfg, log)
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	t.Cleanup(db.Close)
	if err := database.Migrate(ctx, db, log); err != nil {
		t.Fatal(err)
	}
	rdb := redis.NewClient(&redis.Options{
		Addr:     net.JoinHostPort(cfg.Shared.Redis.Host, strconv.Itoa(cfg.Shared.Redis.Port)),
		Password: cfg.Shared.Redis.Password,
		DB:       testRedisDB,
	})
	if err := rdb.Ping(ctx).Err(); err != nil {
		t.Skipf("redis unavailable: %v", err)
	}
	t.Cleanup(func() { rdb.FlushDB(context.Background()); rdb.Close() })

	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	tokens, err := token.NewIssuer(key, token.Options{
		Issuer: cfg.Shared.JWT.Issuer, UserAudience: cfg.Shared.JWT.UserAudience,
		AdminAudience: cfg.Shared.JWT.AdminAudience, AccessTTL: 15 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}

	fakeGitHub := httptest.NewServer(fakeGitHubHandler(githubProfileID))
	t.Cleanup(fakeGitHub.Close)
	cfg.Auth.GitHub.ClientID, cfg.Auth.GitHub.ClientSecret = "test-client", "test-secret"
	cfg.Auth.GitHub.AuthorizeURL = fakeGitHub.URL + "/login/oauth/authorize"
	cfg.Auth.GitHub.TokenURL = fakeGitHub.URL + "/login/oauth/access_token"
	cfg.Auth.GitHub.APIBaseURL = fakeGitHub.URL

	st := store.New(db)
	handler := New(Deps{
		Cfg: cfg, DB: db, Redis: rdb, Store: st, Tokens: tokens, Log: log,
		Sessions: session.NewStore(rdb, time.Hour),
		GitHub:   github.New(cfg.Auth.GitHub),
		Events:   events.NewPublisher(rdb, log),
	})
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return &harness{
		t: t, cfg: cfg, db: db, store: st, tokens: tokens, srv: srv,
		client: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	}
}

func fakeGitHubHandler(profileID int64) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /login/oauth/access_token", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"access_token":"gho_test","token_type":"bearer","scope":"read:user,user:email"}`)
	})
	mux.HandleFunc("GET /user", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer gho_test" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		fmt.Fprintf(w, `{"id":%d,"login":"it-user-%d","name":"Integration Test","email":null,"avatar_url":"https://example.com/a.png"}`, profileID, profileID)
	})
	mux.HandleFunc("GET /user/emails", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `[{"email":"secondary@example.com","primary":false,"verified":true},{"email":"it@example.com","primary":true,"verified":true}]`)
	})
	return mux
}

type req struct {
	method, path string
	body         any
	cookies      []*http.Cookie
	headers      map[string]string
	noInternal   bool
}

func (h *harness) do(r req) (*http.Response, map[string]any) {
	h.t.Helper()
	var body io.Reader
	if r.body != nil {
		b, _ := json.Marshal(r.body)
		body = strings.NewReader(string(b))
	}
	httpReq, _ := http.NewRequest(r.method, h.srv.URL+r.path, body)
	if !r.noInternal {
		httpReq.Header.Set("X-Internal-Token", h.cfg.Shared.InternalToken)
	}
	for k, v := range r.headers {
		httpReq.Header.Set(k, v)
	}
	for _, c := range r.cookies {
		httpReq.AddCookie(&http.Cookie{Name: c.Name, Value: c.Value})
	}
	res, err := h.client.Do(httpReq)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res, out
}

func cookieNamed(res *http.Response, name string) *http.Cookie {
	for _, c := range res.Cookies() {
		if c.Name == name && c.MaxAge >= 0 && c.Value != "" {
			return c
		}
	}
	return nil
}

func expectStatus(t *testing.T, res *http.Response, want int, what string) {
	t.Helper()
	if res.StatusCode != want {
		t.Fatalf("%s: got HTTP %d, want %d", what, res.StatusCode, want)
	}
}

func TestRequestsMustComeThroughGateway(t *testing.T) {
	h := newHarness(t, time.Now().UnixNano())
	res, _ := h.do(req{method: "POST", path: "/admin/auth/login", body: map[string]string{"username": "x", "password": "y"}, noInternal: true})
	expectStatus(t, res, http.StatusUnauthorized, "missing internal token")

	res, _ = h.do(req{method: "GET", path: "/account/me", headers: map[string]string{"X-User-Id": "someone", "X-User-Role": "admin"}})
	expectStatus(t, res, http.StatusUnauthorized, "admin role on user route")

	res, _ = h.do(req{method: "GET", path: "/.well-known/jwks.json", noInternal: true})
	expectStatus(t, res, http.StatusOK, "JWKS is public")
}

func TestAdminLoginLifecycle(t *testing.T) {
	h := newHarness(t, time.Now().UnixNano())
	ctx := context.Background()
	c := h.cfg.Auth.Cookies

	username := fmt.Sprintf("it-admin-%d", time.Now().UnixNano())
	initial := "initial-password-123"
	hash, _ := password.Hash(initial)
	if _, err := h.db.Exec(ctx, `INSERT INTO admins (username, password_hash) VALUES ($1, $2)`, username, hash); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		h.db.Exec(ctx, `DELETE FROM login_events WHERE subject_id IN (SELECT id FROM admins WHERE username = $1)`, username)
		h.db.Exec(ctx, `DELETE FROM admins WHERE username = $1`, username)
	})

	// Unknown user and wrong password look identical.
	res, body := h.do(req{method: "POST", path: "/admin/auth/login", body: map[string]string{"username": "nobody-" + username, "password": "whatever"}})
	expectStatus(t, res, http.StatusUnauthorized, "unknown user")
	res, body2 := h.do(req{method: "POST", path: "/admin/auth/login", body: map[string]string{"username": username, "password": "wrong"}})
	expectStatus(t, res, http.StatusUnauthorized, "wrong password")
	if body["message"] != body2["message"] {
		t.Fatalf("unknown-user and wrong-password responses differ: %v vs %v", body, body2)
	}

	// Correct password (username is case-insensitive) → session + restricted token.
	res, body = h.do(req{method: "POST", path: "/admin/auth/login", body: map[string]string{"username": strings.ToUpper(username), "password": initial}})
	expectStatus(t, res, http.StatusOK, "admin login")
	if admin := body["admin"].(map[string]any); admin["mustChangePassword"] != true {
		t.Fatalf("bootstrap-style admin must be asked to change password: %v", body)
	}
	access, refresh := cookieNamed(res, c.AdminAccess), cookieNamed(res, c.AdminRefresh)
	if access == nil || refresh == nil || !access.HttpOnly || refresh.Path != c.AdminRefreshPath {
		t.Fatalf("admin cookies not set correctly: %v", res.Cookies())
	}
	claims, err := h.tokens.Verify(access.Value, token.RoleAdmin)
	if err != nil || !claims.MustChangePassword {
		t.Fatalf("admin token should verify and carry mcp=true: %v %+v", err, claims)
	}
	identity := map[string]string{"X-User-Id": claims.Subject, "X-User-Role": "admin", "X-Session-Id": claims.SessionID}

	res, body = h.do(req{method: "GET", path: "/admin/account/me", headers: identity})
	expectStatus(t, res, http.StatusOK, "admin me")
	if body["username"] != username {
		t.Fatalf("me returned %v", body)
	}

	// Password change: policy enforced, then token no longer restricted.
	res, _ = h.do(req{method: "POST", path: "/admin/account/password", headers: identity, body: map[string]string{"currentPassword": initial, "newPassword": "short"}})
	expectStatus(t, res, http.StatusUnprocessableEntity, "weak password")
	res, _ = h.do(req{method: "POST", path: "/admin/account/password", headers: identity, body: map[string]string{"currentPassword": "nope", "newPassword": "a-much-better-password"}})
	expectStatus(t, res, http.StatusUnauthorized, "wrong current password")
	newPassword := "a-much-better-password"
	res, _ = h.do(req{method: "POST", path: "/admin/account/password", headers: identity, body: map[string]string{"currentPassword": initial, "newPassword": newPassword}})
	expectStatus(t, res, http.StatusOK, "change password")
	if fresh := cookieNamed(res, c.AdminAccess); fresh == nil {
		t.Fatal("password change must re-issue the access cookie")
	} else if cl, err := h.tokens.Verify(fresh.Value, token.RoleAdmin); err != nil || cl.MustChangePassword {
		t.Fatalf("new token must not be restricted: %v %+v", err, cl)
	}

	// Refresh rotates; the old token survives only for the grace window; logout ends it.
	res, _ = h.do(req{method: "POST", path: "/admin/auth/refresh", cookies: []*http.Cookie{refresh}})
	expectStatus(t, res, http.StatusOK, "refresh")
	rotated := cookieNamed(res, c.AdminRefresh)
	if rotated == nil || rotated.Value == refresh.Value {
		t.Fatal("refresh must rotate the refresh token")
	}
	res, _ = h.do(req{method: "POST", path: "/admin/auth/refresh", cookies: []*http.Cookie{refresh}})
	expectStatus(t, res, http.StatusOK, "concurrent refresh within grace window")
	res, _ = h.do(req{method: "POST", path: "/admin/auth/logout", cookies: []*http.Cookie{rotated}})
	expectStatus(t, res, http.StatusNoContent, "logout")
	res, _ = h.do(req{method: "POST", path: "/admin/auth/refresh", cookies: []*http.Cookie{rotated}})
	expectStatus(t, res, http.StatusUnauthorized, "refresh after logout")

	// Lockout: max failures, then even the right password gets 423.
	for i := 0; i < h.cfg.Auth.Admin.MaxFailedAttempts; i++ {
		res, _ = h.do(req{method: "POST", path: "/admin/auth/login", body: map[string]string{"username": username, "password": "wrong"}})
		expectStatus(t, res, http.StatusUnauthorized, "failed attempt")
	}
	res, _ = h.do(req{method: "POST", path: "/admin/auth/login", body: map[string]string{"username": username, "password": newPassword}})
	expectStatus(t, res, http.StatusLocked, "locked account")
	if res.Header.Get("Retry-After") == "" {
		t.Fatal("locked response must include Retry-After")
	}
}

func TestGitHubLoginFlow(t *testing.T) {
	profileID := time.Now().UnixNano()
	h := newHarness(t, profileID)
	ctx := context.Background()
	c := h.cfg.Auth.Cookies
	t.Cleanup(func() {
		h.db.Exec(ctx, `DELETE FROM login_events WHERE subject_id IN (SELECT id FROM users WHERE github_id = $1)`, profileID)
		h.db.Exec(ctx, `DELETE FROM users WHERE github_id = $1`, profileID)
	})

	res, _ := h.do(req{method: "GET", path: "/auth/github/login"})
	expectStatus(t, res, http.StatusFound, "login redirect")
	loc, _ := url.Parse(res.Header.Get("Location"))
	state := loc.Query().Get("state")
	stateCookie := cookieNamed(res, c.OAuthState)
	if !strings.HasSuffix(loc.Path, "/login/oauth/authorize") || state == "" || stateCookie == nil || stateCookie.Value != state {
		t.Fatalf("bad authorize redirect %s / cookie %v", loc, stateCookie)
	}

	// Without the browser-binding cookie the callback is rejected (login CSRF).
	res, _ = h.do(req{method: "GET", path: "/auth/github/callback?code=abc&state=" + state})
	expectStatus(t, res, http.StatusFound, "callback without cookie")
	if !strings.Contains(res.Header.Get("Location"), "error=invalid_state") {
		t.Fatalf("expected invalid_state, got %s", res.Header.Get("Location"))
	}

	res, _ = h.do(req{method: "GET", path: "/auth/github/callback?code=abc&state=" + state, cookies: []*http.Cookie{stateCookie}})
	expectStatus(t, res, http.StatusFound, "callback")
	if got := res.Header.Get("Location"); got != h.cfg.Auth.Portals.UserURL+"/" {
		t.Fatalf("expected redirect to portal, got %s", got)
	}
	access := cookieNamed(res, c.UserAccess)
	if access == nil || cookieNamed(res, c.UserRefresh) == nil {
		t.Fatalf("user cookies missing: %v", res.Cookies())
	}
	claims, err := h.tokens.Verify(access.Value, token.RoleUser)
	if err != nil {
		t.Fatal(err)
	}

	// State is single-use.
	res, _ = h.do(req{method: "GET", path: "/auth/github/callback?code=abc&state=" + state, cookies: []*http.Cookie{stateCookie}})
	if !strings.Contains(res.Header.Get("Location"), "error=invalid_state") {
		t.Fatalf("replayed state must be rejected, got %s", res.Header.Get("Location"))
	}

	res, body := h.do(req{method: "GET", path: "/account/me", headers: map[string]string{"X-User-Id": claims.Subject, "X-User-Role": "user"}})
	expectStatus(t, res, http.StatusOK, "me")
	if body["login"] != fmt.Sprintf("it-user-%d", profileID) || body["email"] != "it@example.com" {
		t.Fatalf("unexpected profile %v (email should fall back to primary verified)", body)
	}

	// Internal endpoints used by analytics-service.
	res, body = h.do(req{method: "GET", path: "/internal/users/summary"})
	expectStatus(t, res, http.StatusOK, "users summary")
	if users := body["users"].(map[string]any); users["total"].(float64) < 1 || users["activeToday"].(float64) < 1 {
		t.Fatalf("summary should count the new user: %v", body)
	}
	if body["signedInUserSessions"].(float64) < 1 {
		t.Fatalf("summary should count the new session: %v", body)
	}
	res, body = h.do(req{method: "GET", path: fmt.Sprintf("/internal/users?search=it-user-%d", profileID)})
	expectStatus(t, res, http.StatusOK, "users search")
	if body["total"].(float64) != 1 {
		t.Fatalf("search should find exactly the new user: %v", body)
	}
	res, body = h.do(req{method: "GET", path: "/internal/users?ids=" + claims.Subject + ",not-a-uuid"})
	expectStatus(t, res, http.StatusOK, "users by ids")
	if body["total"].(float64) != 1 {
		t.Fatalf("ids lookup should resolve the one valid id: %v", body)
	}
	res, _ = h.do(req{method: "GET", path: "/internal/users/summary", noInternal: true})
	expectStatus(t, res, http.StatusUnauthorized, "internal endpoints need the internal token")
}
