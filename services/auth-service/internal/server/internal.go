package server

import (
	"net/http"
	"strconv"
	"strings"

	"aerotrack/auth-service/internal/session"
)

// Service-to-service endpoints for analytics-service. They are NOT routed by the gateway
// (no /api prefix maps to /internal), and require the internal token like every other route.

// GET /internal/users/summary
func (s *server) usersSummary(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	summary, err := s.Store.UserSummary(ctx)
	if err != nil {
		s.Log.Error("user summary", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "could not load user summary")
		return
	}
	users, uErr := s.Sessions.CountActive(ctx, session.KindUser)
	admins, aErr := s.Sessions.CountActive(ctx, session.KindAdmin)
	if uErr != nil || aErr != nil {
		s.Log.Warn("count active sessions", "userErr", uErr, "adminErr", aErr)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"users":                 summary,
		"signedInUserSessions":  users,
		"signedInAdminSessions": admins,
	})
}

// GET /internal/users?search=&limit=&offset=   or   ?ids=a,b,c
func (s *server) listUsers(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if raw := strings.TrimSpace(q.Get("ids")); raw != "" {
		ids := strings.Split(raw, ",")
		if len(ids) > 200 {
			ids = ids[:200]
		}
		users, err := s.Store.UsersByIDs(r.Context(), ids)
		if err != nil {
			s.Log.Error("users by ids", "err", err)
			writeError(w, http.StatusInternalServerError, "internal", "could not load users")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"users": users, "total": len(users)})
		return
	}
	limit := clampInt(q.Get("limit"), 50, 1, 200)
	offset := clampInt(q.Get("offset"), 0, 0, 1_000_000)
	search := strings.TrimSpace(q.Get("search"))
	if len(search) > 100 {
		search = search[:100]
	}
	users, total, err := s.Store.ListUsers(r.Context(), search, limit, offset)
	if err != nil {
		s.Log.Error("list users", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "could not load users")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": users, "total": total, "limit": limit, "offset": offset})
}

func clampInt(raw string, def, lo, hi int) int {
	n, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	return max(lo, min(hi, n))
}
