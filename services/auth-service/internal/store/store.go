// Package store holds the auth schema queries (users, admins, login audit trail).
package store

import (
	"context"
	"errors"
	"net/netip"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"aerotrack/auth-service/internal/github"
)

var ErrNotFound = errors.New("store: not found")

type Store struct{ db *pgxpool.Pool }

func New(db *pgxpool.Pool) *Store { return &Store{db: db} }

// ---------------------------------------------------------------- users ---

type User struct {
	ID          string     `json:"id"`
	GitHubID    int64      `json:"githubId"`
	Login       string     `json:"login"`
	Name        *string    `json:"name"`
	Email       *string    `json:"email"`
	AvatarURL   *string    `json:"avatarUrl"`
	IsActive    bool       `json:"isActive"`
	CreatedAt   time.Time  `json:"createdAt"`
	LastLoginAt *time.Time `json:"lastLoginAt"`
}

const userColumns = `id, github_id, login, name, email, avatar_url, is_active, created_at, last_login_at`

func scanUser(row pgx.Row) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.GitHubID, &u.Login, &u.Name, &u.Email, &u.AvatarURL, &u.IsActive, &u.CreatedAt, &u.LastLoginAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrNotFound
	}
	return u, err
}

// UpsertGitHubUser creates or refreshes a user from their GitHub profile. created reports a first sign-up.
func (s *Store) UpsertGitHubUser(ctx context.Context, p github.Profile) (u User, created bool, err error) {
	row := s.db.QueryRow(ctx, `
		INSERT INTO users (github_id, login, name, email, avatar_url, last_login_at)
		VALUES ($1, $2, $3, $4, $5, now())
		ON CONFLICT (github_id) DO UPDATE SET
			login         = EXCLUDED.login,
			name          = EXCLUDED.name,
			email         = COALESCE(EXCLUDED.email, users.email),
			avatar_url    = EXCLUDED.avatar_url,
			last_login_at = now(),
			updated_at    = now()
		RETURNING `+userColumns+`, (xmax = 0) AS created`,
		p.ID, p.Login, p.Name, p.Email, p.AvatarURL)
	err = row.Scan(&u.ID, &u.GitHubID, &u.Login, &u.Name, &u.Email, &u.AvatarURL, &u.IsActive, &u.CreatedAt, &u.LastLoginAt, &created)
	return u, created, err
}

func (s *Store) UserByID(ctx context.Context, id string) (User, error) {
	return scanUser(s.db.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE id = $1`, id))
}

// --------------------------------------------------------------- admins ---

type Admin struct {
	ID                 string     `json:"id"`
	Username           string     `json:"username"`
	PasswordHash       string     `json:"-"`
	MustChangePassword bool       `json:"mustChangePassword"`
	FailedAttempts     int        `json:"-"`
	LockedUntil        *time.Time `json:"-"`
	CreatedAt          time.Time  `json:"createdAt"`
	LastLoginAt        *time.Time `json:"lastLoginAt"`
}

// IsLocked reports whether the account is currently locked out.
func (a Admin) IsLocked(now time.Time) bool { return a.LockedUntil != nil && a.LockedUntil.After(now) }

// NormalizeUsername makes usernames case-insensitive and trims surrounding whitespace.
func NormalizeUsername(u string) string { return strings.ToLower(strings.TrimSpace(u)) }

const adminColumns = `id, username, password_hash, must_change_password, failed_attempts, locked_until, created_at, last_login_at`

func scanAdmin(row pgx.Row) (Admin, error) {
	var a Admin
	err := row.Scan(&a.ID, &a.Username, &a.PasswordHash, &a.MustChangePassword, &a.FailedAttempts, &a.LockedUntil, &a.CreatedAt, &a.LastLoginAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Admin{}, ErrNotFound
	}
	return a, err
}

func (s *Store) AdminByUsername(ctx context.Context, username string) (Admin, error) {
	return scanAdmin(s.db.QueryRow(ctx, `SELECT `+adminColumns+` FROM admins WHERE username = $1`, NormalizeUsername(username)))
}

func (s *Store) AdminByID(ctx context.Context, id string) (Admin, error) {
	return scanAdmin(s.db.QueryRow(ctx, `SELECT `+adminColumns+` FROM admins WHERE id = $1`, id))
}

func (s *Store) HasAnyAdmin(ctx context.Context) (bool, error) {
	var exists bool
	err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM admins)`).Scan(&exists)
	return exists, err
}

// EnsureBootstrapAdmin creates the first admin only when no admin exists at all.
func (s *Store) EnsureBootstrapAdmin(ctx context.Context, username, passwordHash string) (bool, error) {
	tag, err := s.db.Exec(ctx, `
		INSERT INTO admins (username, password_hash, must_change_password)
		SELECT $1, $2, TRUE
		WHERE NOT EXISTS (SELECT 1 FROM admins)
		ON CONFLICT (username) DO NOTHING`, NormalizeUsername(username), passwordHash)
	return tag.RowsAffected() == 1, err
}

// RecordAdminFailure counts a failed login; reaching maxAttempts locks the account and resets the counter.
func (s *Store) RecordAdminFailure(ctx context.Context, id string, maxAttempts int, lockout time.Duration) (locked bool, err error) {
	var lockedUntil *time.Time
	err = s.db.QueryRow(ctx, `
		UPDATE admins SET
			locked_until    = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(secs => $3) ELSE locked_until END,
			failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END,
			updated_at      = now()
		WHERE id = $1
		RETURNING locked_until`, id, maxAttempts, lockout.Seconds()).Scan(&lockedUntil)
	return lockedUntil != nil && lockedUntil.After(time.Now()), err
}

func (s *Store) RecordAdminSuccess(ctx context.Context, id string) error {
	_, err := s.db.Exec(ctx, `
		UPDATE admins SET failed_attempts = 0, locked_until = NULL, last_login_at = now(), updated_at = now()
		WHERE id = $1`, id)
	return err
}

func (s *Store) SetAdminPassword(ctx context.Context, id, passwordHash string) error {
	_, err := s.db.Exec(ctx, `
		UPDATE admins SET password_hash = $2, must_change_password = FALSE, updated_at = now()
		WHERE id = $1`, id, passwordHash)
	return err
}

// ---------------------------------------------------------- login audit ---

type LoginEvent struct {
	SubjectType string // "user" | "admin"
	SubjectID   string // empty when the subject is unknown (e.g. bad username)
	Success     bool
	Reason      string
	IP          string
	UserAgent   string
}

func (s *Store) RecordLogin(ctx context.Context, e LoginEvent) error {
	var subject, reason, ua *string
	if e.SubjectID != "" {
		subject = &e.SubjectID
	}
	if e.Reason != "" {
		reason = &e.Reason
	}
	if e.UserAgent != "" {
		v := e.UserAgent
		if len(v) > 512 {
			v = v[:512]
		}
		ua = &v
	}
	var ip *netip.Addr
	if addr, err := netip.ParseAddr(e.IP); err == nil {
		ip = &addr
	}
	_, err := s.db.Exec(ctx, `
		INSERT INTO login_events (subject_type, subject_id, success, reason, ip, user_agent)
		VALUES ($1, $2, $3, $4, $5, $6)`, e.SubjectType, subject, e.Success, reason, ip, ua)
	return err
}
