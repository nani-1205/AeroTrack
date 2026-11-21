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
	"aerotrack/auth-service/internal/server"
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

	srv := &http.Server{
		Addr:              cfg.Auth.Listen,
		Handler:           server.New(server.Deps{DB: db, Redis: rdb, Log: log}),
		ReadHeaderTimeout: 5 * time.Second,
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
