package server

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

	"aerotrack/auth-service/internal/session"
)

const maxBodyBytes = 4 << 10

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}

// decodeJSON reads a small JSON body, rejecting unknown fields.
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return false
	}
	return true
}

// clientIP prefers the address the gateway forwarded (trusted: internal-token checked).
func clientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		first, _, _ := strings.Cut(fwd, ",")
		return strings.TrimSpace(first)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ------------------------------------------------------------- cookies ---

type cookieNames struct{ access, refresh, refreshPath string }

func (s *server) names(kind session.Kind) cookieNames {
	c := s.Cfg.Auth.Cookies
	if kind == session.KindAdmin {
		return cookieNames{c.AdminAccess, c.AdminRefresh, c.AdminRefreshPath}
	}
	return cookieNames{c.UserAccess, c.UserRefresh, c.UserRefreshPath}
}

func (s *server) sameSite() http.SameSite {
	switch s.Cfg.Auth.Cookies.SameSite {
	case "strict":
		return http.SameSiteStrictMode
	case "none":
		return http.SameSiteNoneMode
	default:
		return http.SameSiteLaxMode
	}
}

func (s *server) cookie(name, value, path string, maxAge int, sameSite http.SameSite) *http.Cookie {
	return &http.Cookie{
		Name: name, Value: value, Path: path, MaxAge: maxAge,
		HttpOnly: true, Secure: s.Cfg.Auth.Cookies.Secure, SameSite: sameSite,
	}
}

func (s *server) setAccessCookie(w http.ResponseWriter, kind session.Kind, access string, exp time.Time) {
	n := s.names(kind)
	http.SetCookie(w, s.cookie(n.access, access, "/", int(time.Until(exp).Seconds()), s.sameSite()))
}

func (s *server) setAuthCookies(w http.ResponseWriter, kind session.Kind, access string, exp time.Time, refresh string) {
	n := s.names(kind)
	s.setAccessCookie(w, kind, access, exp)
	http.SetCookie(w, s.cookie(n.refresh, refresh, n.refreshPath, int(s.Sessions.TTL().Seconds()), s.sameSite()))
}

func (s *server) clearAuthCookies(w http.ResponseWriter, kind session.Kind) {
	n := s.names(kind)
	http.SetCookie(w, s.cookie(n.access, "", "/", -1, s.sameSite()))
	http.SetCookie(w, s.cookie(n.refresh, "", n.refreshPath, -1, s.sameSite()))
}

func (s *server) refreshCookie(r *http.Request, kind session.Kind) (string, bool) {
	c, err := r.Cookie(s.names(kind).refresh)
	if err != nil || c.Value == "" {
		return "", false
	}
	return c.Value, true
}

func isNotFound(err error) bool { return errors.Is(err, session.ErrNotFound) }
