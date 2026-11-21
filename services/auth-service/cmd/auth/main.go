// Command auth is the AeroTrack authentication service (GitHub SSO users + admin accounts).
package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"aerotrack/auth-service/internal/config"
	"aerotrack/auth-service/internal/database"
	"aerotrack/auth-service/internal/events"
	"aerotrack/auth-service/internal/github"
	"aerotrack/auth-service/internal/password"
	"aerotrack/auth-service/internal/server"
	"aerotrack/auth-service/internal/session"
	"aerotrack/auth-service/internal/store"
	"aerotrack/auth-service/internal/token"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", "auth")
	if err := run(log); err != nil {
		log.Error("auth-service stopped", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	log.Info("config loaded", "path", cfg.Path, "env", cfg.Env)
	for _, w := range cfg.Warnings() {
		log.Warn(w)
	}

	tokens, err := token.LoadIssuer(cfg.ResolvePath(cfg.Auth.JWTPrivateKeyPath), cfg.ResolvePath(cfg.Auth.JWTPublicKeyPath), token.Options{
		Issuer:        cfg.Shared.JWT.Issuer,
		UserAudience:  cfg.Shared.JWT.UserAudience,
		AdminAudience: cfg.Shared.JWT.AdminAudience,
		AccessTTL:     time.Duration(cfg.Shared.JWT.AccessTTLSeconds) * time.Second,
	})
	if err != nil {
		return err
	}

	db, err := database.Connect(ctx, cfg, log)
	if err != nil {
		return err
	}
	defer db.Close()
	if err := database.Migrate(ctx, db, log); err != nil {
		return err
	}

	rdb := redis.NewClient(&redis.Options{
		Addr:     net.JoinHostPort(cfg.Shared.Redis.Host, strconv.Itoa(cfg.Shared.Redis.Port)),
		Password: cfg.Shared.Redis.Password,
		DB:       cfg.Shared.Redis.DB,
	})
	defer rdb.Close()

	st := store.New(db)
	if err := bootstrapAdmin(ctx, cfg, st, log); err != nil {
		return err
	}

	handler := server.New(server.Deps{
		Cfg:      cfg,
		DB:       db,
		Redis:    rdb,
		Store:    st,
		Sessions: session.NewStore(rdb, time.Duration(cfg.Shared.JWT.RefreshTTLSeconds)*time.Second),
		Tokens:   tokens,
		GitHub:   github.New(cfg.Auth.GitHub),
		Events:   events.NewPublisher(rdb, log),
		Log:      log,
	})
	srv := &http.Server{
		Addr:              cfg.Auth.Listen,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", cfg.Auth.Listen)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		log.Info("shutting down")
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

// bootstrapAdmin creates the first admin (must change password on first sign-in) when none exist.
func bootstrapAdmin(ctx context.Context, cfg *config.Config, st *store.Store, log *slog.Logger) error {
	exists, err := st.HasAnyAdmin(ctx)
	if err != nil || exists {
		return err
	}
	hash, err := password.Hash(cfg.Auth.Admin.BootstrapPassword)
	if err != nil {
		return err
	}
	created, err := st.EnsureBootstrapAdmin(ctx, cfg.Auth.Admin.BootstrapUsername, hash)
	if err != nil {
		return err
	}
	if created {
		log.Info("bootstrap admin created — password change required on first sign-in",
			"username", store.NormalizeUsername(cfg.Auth.Admin.BootstrapUsername))
	}
	return nil
}
