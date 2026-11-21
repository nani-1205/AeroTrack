package server

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"aerotrack/auth-service/internal/events"
	"aerotrack/auth-service/internal/password"
	"aerotrack/auth-service/internal/session"
	"aerotrack/auth-service/internal/store"
	"aerotrack/auth-service/internal/token"
)

const msgInvalidCredentials = "invalid username or password"

type adminView struct {
	ID                 string     `json:"id"`
	Username           string     `json:"username"`
	MustChangePassword bool       `json:"mustChangePassword"`
	LastLoginAt        *time.Time `json:"lastLoginAt"`
}

func viewOf(a store.Admin) adminView {
	return adminView{ID: a.ID, Username: a.Username, MustChangePassword: a.MustChangePassword, LastLoginAt: a.LastLoginAt}
}

// POST /admin/auth/login {username, password}
func (s *server) adminLogin(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.Username == "" || body.Password == "" || len(body.Password) > password.MaxLength {
		writeError(w, http.StatusBadRequest, "bad_request", "username and password are required")
		return
	}
	ip, ua := clientIP(r), r.UserAgent()
	fail := func(subjectID, reason string) {
		s.audit(r, store.LoginEvent{SubjectType: "admin", SubjectID: subjectID, Reason: reason, IP: ip, UserAgent: ua})
		s.Events.Publish(ctx, events.AdminLoginFailed, "admin", subjectID)
		logins.WithLabelValues("admin", reason).Inc()
	}

	admin, err := s.Store.AdminByUsername(ctx, body.Username)
	if errors.Is(err, store.ErrNotFound) {
		password.VerifyDummy(body.Password) // same timing as a real check: don't reveal valid usernames
		fail("", "unknown_user")
		writeError(w, http.StatusUnauthorized, "invalid_credentials", msgInvalidCredentials)
		return
	}
	if err != nil {
		s.Log.Error("load admin", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "could not sign in")
		return
	}

	ok, err := password.Verify(body.Password, admin.PasswordHash)
	if err != nil {
		s.Log.Error("verify admin password", "adminId", admin.ID, "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "could not sign in")
		return
	}
	locked := admin.IsLocked(s.now())
	if !ok {
		if !locked {
			nowLocked, err := s.Store.RecordAdminFailure(ctx, admin.ID, s.Cfg.Auth.Admin.MaxFailedAttempts,
				time.Duration(s.Cfg.Auth.Admin.LockoutMinutes)*time.Minute)
			if err != nil {
				s.Log.Error("record admin failure", "err", err)
			}
			if nowLocked {
				s.Events.Publish(ctx, events.AdminLocked, "admin", admin.ID)
				s.Log.Warn("admin account locked after repeated failures", "adminId", admin.ID)
			}
		}
		fail(admin.ID, "bad_password")
		writeError(w, http.StatusUnauthorized, "invalid_credentials", msgInvalidCredentials)
		return
	}
	// Only someone who knows the password learns the account is locked.
	if locked {
		fail(admin.ID, "locked")
		w.Header().Set("Retry-After", strconv.Itoa(max(int(time.Until(*admin.LockedUntil).Seconds()), 0)+1))
		writeError(w, http.StatusLocked, "locked", "account temporarily locked after repeated failed sign-ins — try again later")
		return
	}

	if err := s.Store.RecordAdminSuccess(ctx, admin.ID); err != nil {
		s.Log.Error("record admin success", "err", err)
	}
	refresh, sess, err := s.Sessions.Create(ctx, session.KindAdmin, admin.ID, ip, ua)
	if err != nil {
		s.Log.Error("create admin session", "err", err)
		writeError(w, http.StatusServiceUnavailable, "unavailable", "could not sign in")
		return
	}
	access, exp, err := s.Tokens.Issue(admin.ID, sess.ID, token.RoleAdmin, admin.MustChangePassword)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not sign in")
		return
	}
	s.setAuthCookies(w, session.KindAdmin, access, exp, refresh)
	s.audit(r, store.LoginEvent{SubjectType: "admin", SubjectID: admin.ID, Success: true, IP: ip, UserAgent: ua})
	s.Events.Publish(ctx, events.AdminLogin, "admin", admin.ID)
	logins.WithLabelValues("admin", "success").Inc()
	s.Log.Info("admin signed in", "adminId", admin.ID, "username", admin.Username)
	writeJSON(w, http.StatusOK, map[string]any{"admin": viewOf(admin), "expiresAt": exp.UTC()})
}

// POST /admin/auth/refresh
func (s *server) adminRefresh(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	refresh, ok := s.refreshCookie(r, session.KindAdmin)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "no session")
		return
	}
	newRefresh, sess, err := s.Sessions.Rotate(ctx, session.KindAdmin, refresh)
	if err != nil {
		if !isNotFound(err) {
			s.Log.Error("rotate admin session", "err", err)
			writeError(w, http.StatusServiceUnavailable, "unavailable", "could not refresh session")
			return
		}
		s.clearAuthCookies(w, session.KindAdmin)
		writeError(w, http.StatusUnauthorized, "unauthorized", "session expired")
		return
	}
	admin, err := s.Store.AdminByID(ctx, sess.SubjectID)
	if err != nil {
		_, _ = s.Sessions.RevokeSubject(ctx, session.KindAdmin, sess.SubjectID, "")
		s.clearAuthCookies(w, session.KindAdmin)
		writeError(w, http.StatusUnauthorized, "unauthorized", "account unavailable")
		return
	}
	access, exp, err := s.Tokens.Issue(admin.ID, sess.ID, token.RoleAdmin, admin.MustChangePassword)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not issue token")
		return
	}
	s.setAuthCookies(w, session.KindAdmin, access, exp, newRefresh)
	writeJSON(w, http.StatusOK, map[string]any{"admin": viewOf(admin), "expiresAt": exp.UTC()})
}

// POST /admin/auth/logout
func (s *server) adminLogout(w http.ResponseWriter, r *http.Request) {
	if refresh, ok := s.refreshCookie(r, session.KindAdmin); ok {
		if sess, err := s.Sessions.Revoke(r.Context(), session.KindAdmin, refresh); err == nil {
			s.Events.Publish(r.Context(), events.AdminLogout, "admin", sess.SubjectID)
		} else if !isNotFound(err) {
			s.Log.Error("revoke admin session", "err", err)
		}
	}
	s.clearAuthCookies(w, session.KindAdmin)
	w.WriteHeader(http.StatusNoContent)
}

// GET /admin/account/me
func (s *server) adminMe(w http.ResponseWriter, r *http.Request, p principal) {
	admin, err := s.Store.AdminByID(r.Context(), p.ID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusUnauthorized, "unauthorized", "account unavailable")
		return
	}
	if err != nil {
		s.Log.Error("load admin", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "could not load account")
		return
	}
	writeJSON(w, http.StatusOK, viewOf(admin))
}

// POST /admin/account/password {currentPassword, newPassword}
// Also signs out every other session of this admin and re-issues an unrestricted access token.
func (s *server) adminChangePassword(w http.ResponseWriter, r *http.Request, p principal) {
	ctx := r.Context()
	var body struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	admin, err := s.Store.AdminByID(ctx, p.ID)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthorized", "account unavailable")
		return
	}
	if len(body.CurrentPassword) > password.MaxLength {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "current password is incorrect")
		return
	}
	if ok, err := password.Verify(body.CurrentPassword, admin.PasswordHash); err != nil || !ok {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "current password is incorrect")
		return
	}
	if err := password.Validate(body.NewPassword, s.Cfg.Auth.Admin.MinPasswordLength); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "weak_password", err.Error())
		return
	}
	if body.NewPassword == body.CurrentPassword {
		writeError(w, http.StatusUnprocessableEntity, "weak_password", "new password must differ from the current one")
		return
	}
	hash, err := password.Hash(body.NewPassword)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "could not change password")
		return
	}
	if err := s.Store.SetAdminPassword(ctx, admin.ID, hash); err != nil {
		s.Log.Error("set admin password", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "could not change password")
		return
	}
	revoked, err := s.Sessions.RevokeSubject(ctx, session.KindAdmin, admin.ID, p.SessionID)
	if err != nil {
		s.Log.Error("revoke other admin sessions", "err", err)
	}
	access, exp, err := s.Tokens.Issue(admin.ID, p.SessionID, token.RoleAdmin, false)
	if err == nil {
		s.setAccessCookie(w, session.KindAdmin, access, exp)
	}
	s.Events.Publish(ctx, events.AdminPasswordChanged, "admin", admin.ID)
	s.Log.Info("admin password changed", "adminId", admin.ID, "otherSessionsRevoked", revoked)

	admin.MustChangePassword = false
	writeJSON(w, http.StatusOK, map[string]any{"admin": viewOf(admin)})
}
