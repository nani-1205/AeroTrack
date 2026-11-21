// Package events publishes auth events to the Redis stream consumed by analytics-service.
package events

import (
	"context"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

// Stream is the Redis stream name. Contract with analytics-service.
const Stream = "events:auth"

const (
	UserSignup           = "user.signup"
	UserLogin            = "user.login"
	UserLogout           = "user.logout"
	AdminLogin           = "admin.login"
	AdminLoginFailed     = "admin.login_failed"
	AdminLocked          = "admin.locked"
	AdminLogout          = "admin.logout"
	AdminPasswordChanged = "admin.password_changed"
)

type Publisher struct {
	rdb *redis.Client
	log *slog.Logger
}

func NewPublisher(rdb *redis.Client, log *slog.Logger) *Publisher {
	return &Publisher{rdb: rdb, log: log}
}

// Publish is best-effort: analytics must never block or break a login.
func (p *Publisher) Publish(ctx context.Context, eventType, subjectType, subjectID string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
	defer cancel()
	err := p.rdb.XAdd(ctx, &redis.XAddArgs{
		Stream: Stream,
		MaxLen: 100_000,
		Approx: true,
		Values: map[string]any{
			"type":        eventType,
			"subjectType": subjectType,
			"subjectId":   subjectID,
			"at":          time.Now().UTC().Format(time.RFC3339Nano),
		},
	}).Err()
	if err != nil {
		p.log.Warn("publish auth event failed", "type", eventType, "err", err)
	}
}
