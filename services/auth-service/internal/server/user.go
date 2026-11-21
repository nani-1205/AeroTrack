package server

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"time"

	"github.com/redis/go-redis/v9"

	"aerotrack/auth-service/internal/events"
	"aerotrack/auth-service/internal/session"
	"aerotrack/auth-service/internal/store"
	"aerotrack/auth-service/internal/token"
)

const oauthStateTTL = 10 * time.Minute

func oauthStateKey(state string) string { return "auth:oauth-state:" + state }

// redirectToPortal sends the browser back to the user portal, optionally with an error code.
func (s *server) redirectToPortal(w http.ResponseWriter, r *http.Request, errCode string) {
	target := s.Cfg.Auth.Portals.UserURL + "/"
	if errCode != "" {
		target = s.Cfg.Auth.Portals.UserURL + "/login?error=" + url.QueryEscape(errCode)
	}
	http.Redirect(w, r, target, http.StatusFound)
}

// GET /auth/github/login — start the OAuth web flow.
func (s *server) githubLogin(w http.ResponseWriter, r *http.Request) {
	if !s.Cfg.Auth.GitHub.Configured() {
		s.Log.Warn("github login attempted but auth.github credentials are not configured")
		s.redirectToPortal(w, r, "github_not_configured")
		return
	}
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not start login")
		return
	}
	state := base64.RawURLEncoding.EncodeToString(raw)
	if err := s.Redis.Set(r.Context(), oauthStateKey(state), "1", oauthStateTTL).Err(); err != nil {
		s.Log.Error("store oauth state", "err", err)
		writeError(w, http.StatusServiceUnavailable, "unavailable", "could not start login")
		return
	}
	// Binds the flow to this browser (login-CSRF protection). Must be Lax: GitHub redirects back cross-site.
	c := s.Cfg.Auth.Cookies
	http.SetCookie(w, s.cookie(c.OAuthState, state, c.OAuthStatePath, int(oauthStateTTL.Seconds()), http.SameSiteLaxMode))
	http.Redirect(w, r, s.GitHub.AuthCodeURL(state), http.StatusFound)
}

// GET /auth/github/callback — GitHub redirects here with ?code&state.
func (s *server) githubCallback(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()
	c := s.Cfg.Auth.Cookies
	http.SetCookie(w, s.cookie(c.OAuthState, "", c.OAuthStatePath, -1, http.SameSiteLaxMode))

	if q.Get("error") != "" {
		s.redirectToPortal(w, r, "github_denied")
		return
	}
	state, code := q.Get("state"), q.Get("code")
	cookie, err := r.Cookie(c.OAuthState)
	if state == "" || code == "" || err != nil || subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(state)) != 1 {
		s.redirectToPortal(w, r, "invalid_state")
		return
	}
	// Single use: GETDEL fails for replayed or expired states.
	if err := s.Redis.GetDel(ctx, oauthStateKey(state)).Err(); err != nil {
		if !errors.Is(err, redis.Nil) {
			s.Log.Error("read oauth state", "err", err)
		}
		s.redirectToPortal(w, r, "invalid_state")
		return
	}

	profile, err := s.GitHub.FetchProfile(ctx, code)
	if err != nil {
		s.Log.Error("github profile", "err", err)
		logins.WithLabelValues("user", "github_error").Inc()
		s.redirectToPortal(w, r, "github_error")
		return
	}
	user, created, err := s.Store.UpsertGitHubUser(ctx, profile)
	if err != nil {
		s.Log.Error("upsert user", "err", err)
		s.redirectToPortal(w, r, "server_error")
		return
	}
	ip, ua := clientIP(r), r.UserAgent()
	if !user.IsActive {
		s.audit(r, store.LoginEvent{SubjectType: "user", SubjectID: user.ID, Reason: "disabled", IP: ip, UserAgent: ua})
		logins.WithLabelValues("user", "disabled").Inc()
		s.redirectToPortal(w, r, "account_disabled")
		return
	}

	refresh, sess, err := s.Sessions.Create(ctx, session.KindUser, user.ID, ip, ua)
	if err != nil {
		s.Log.Error("create session", "err", err)
		s.redirectToPortal(w, r, "server_error")
		return
	}
	access, exp, err := s.Tokens.Issue(user.ID, sess.ID, token.RoleUser, false)
	if err != nil {
		s.Log.Error("issue token", "err", err)
		s.redirectToPortal(w, r, "server_error")
		return
	}
	s.setAuthCookies(w, session.KindUser, access, exp, refresh)

	s.audit(r, store.LoginEvent{SubjectType: "user", SubjectID: user.ID, Success: true, IP: ip, UserAgent: ua})
	if created {
		s.Events.Publish(ctx, events.UserSignup, "user", user.ID)
	}
	s.Events.Publish(ctx, events.UserLogin, "user", user.ID)
	logins.WithLabelValues("user", "success").Inc()
	s.Log.Info("user signed in", "userId", user.ID, "login", user.Login, "new", created)
	s.redirectToPortal(w, r, "")
}

// POST /auth/refresh — rotate the refresh token, issue a fresh access token.
func (s *server) userRefresh(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	refresh, ok := s.refreshCookie(r, session.KindUser)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "no session")
		return
	}
	newRefresh, sess, err := s.Sessions.Rotate(ctx, session.KindUser, refresh)
	if err != nil {
		if !isNotFound(err) {
			s.Log.Error("rotate session", "err", err)
			writeError(w, http.StatusServiceUnavailable, "unavailable", "could not refresh session")
			return
		}
		s.clearAuthCookies(w, session.KindUser)
		writeError(w, http.StatusUnauthorized, "unauthorized", "session expired")
		return
	}
	user, err := s.Store.UserByID(ctx, sess.SubjectID)
	if err != nil || !user.IsActive {
		_, _ = s.Sessions.RevokeSubject(ctx, session.KindUser, sess.SubjectID, "")
		s.clearAuthCookies(w, session.KindUser)
		writeError(w, http.StatusUnauthorized, "unauthorized", "account unavailable")
		return
	}
	access, exp, err := s.Tokens.Issue(user.ID, sess.ID, token.RoleUser, false)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not issue token")
		return
	}
	s.setAuthCookies(w, session.KindUser, access, exp, newRefresh)
	writeJSON(w, http.StatusOK, map[string]any{"expiresAt": exp.UTC()})
}

// POST /auth/logout
func (s *server) userLogout(w http.ResponseWriter, r *http.Request) {
	if refresh, ok := s.refreshCookie(r, session.KindUser); ok {
		if sess, err := s.Sessions.Revoke(r.Context(), session.KindUser, refresh); err == nil {
			s.Events.Publish(r.Context(), events.UserLogout, "user", sess.SubjectID)
		} else if !isNotFound(err) {
			s.Log.Error("revoke session", "err", err)
		}
	}
	s.clearAuthCookies(w, session.KindUser)
	w.WriteHeader(http.StatusNoContent)
}

// GET /account/me
func (s *server) userMe(w http.ResponseWriter, r *http.Request, p principal) {
	user, err := s.Store.UserByID(r.Context(), p.ID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && !user.IsActive) {
		writeError(w, http.StatusUnauthorized, "unauthorized", "account unavailable")
		return
	}
	if err != nil {
		s.Log.Error("load user", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "could not load account")
		return
	}
	writeJSON(w, http.StatusOK, user)
}

// audit writes the login trail; failures are logged, never surfaced to the caller.
func (s *server) audit(r *http.Request, e store.LoginEvent) {
	if err := s.Store.RecordLogin(r.Context(), e); err != nil {
		s.Log.Warn("record login event", "err", err)
	}
}
