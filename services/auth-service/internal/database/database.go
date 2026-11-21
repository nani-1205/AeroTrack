// Package database connects to PostgreSQL (waiting until it is available) and applies
// pending schema migrations at startup.
//
// Migration policy (shared by every AeroTrack service):
//   - only PENDING migrations are applied, forward-only;
//   - a Postgres advisory lock serialises concurrent replicas;
//   - nothing is ever forced/reset: missing or out-of-order migrations abort startup.
package database

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/url"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/database"
	"github.com/pressly/goose/v3/lock"

	"aerotrack/auth-service/internal/config"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Connect opens a pool scoped to the service's own schema and retries until the DB answers.
func Connect(ctx context.Context, cfg *config.Config, log *slog.Logger) (*pgxpool.Pool, error) {
	pg := cfg.Shared.Postgres
	dsn := url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(cfg.Auth.DB.User, cfg.Auth.DB.Password),
		Host:   net.JoinHostPort(pg.Host, strconv.Itoa(pg.Port)),
		Path:   "/" + pg.Database,
		RawQuery: url.Values{
			"sslmode":          {pg.SSLMode},
			"connect_timeout":  {strconv.Itoa(max(pg.ConnectTimeoutSeconds, 1))},
			"application_name": {"auth-service"},
		}.Encode(),
	}
	poolCfg, err := pgxpool.ParseConfig(dsn.String())
	if err != nil {
		return nil, fmt.Errorf("parse postgres config: %w", err)
	}
	poolCfg.ConnConfig.RuntimeParams["search_path"] = cfg.Auth.DB.Schema

	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, fmt.Errorf("create postgres pool: %w", err)
	}

	retries := max(pg.StartupRetries, 1)
	backoff := time.Second
	for attempt := 1; ; attempt++ {
		pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err = pool.Ping(pingCtx)
		cancel()
		if err == nil {
			log.Info("postgres is available", "host", pg.Host, "schema", cfg.Auth.DB.Schema, "attempt", attempt)
			return pool, nil
		}
		if attempt >= retries {
			pool.Close()
			return nil, fmt.Errorf("postgres not available after %d attempts: %w", attempt, err)
		}
		log.Warn("waiting for postgres", "attempt", attempt, "of", retries, "err", err)
		select {
		case <-ctx.Done():
			pool.Close()
			return nil, ctx.Err()
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 5*time.Second)
	}
}

// Migrate applies pending migrations under a session-level advisory lock.
func Migrate(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger) error {
	sqlDB := stdlib.OpenDBFromPool(pool)

	fsys, err := fs.Sub(migrationsFS, "migrations")
	if err != nil {
		return err
	}
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return fmt.Errorf("create migration locker: %w", err)
	}
	provider, err := goose.NewProvider(database.DialectPostgres, sqlDB, fsys,
		goose.WithSessionLocker(locker),
	)
	if err != nil {
		return fmt.Errorf("create migration provider: %w", err)
	}

	current, err := provider.GetDBVersion(ctx)
	if err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	results, err := provider.Up(ctx)
	if err != nil {
		return fmt.Errorf("migration failed (schema left at last successful version, nothing forced): %w", err)
	}
	if len(results) == 0 {
		log.Info("schema up to date — no pending migrations", "version", current)
		return nil
	}
	for _, r := range results {
		log.Info("applied migration", "version", r.Source.Version, "file", r.Source.Path, "duration", r.Duration)
	}
	return nil
}
