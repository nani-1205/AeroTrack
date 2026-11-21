// Package session stores refresh-token sessions in Redis.
//
// Keys (all prefixed "auth:"):
//
//	auth:refresh:<sha256(token)>  → session JSON           (TTL = refresh TTL)
//	auth:sid:<sessionID>          → sha256(current token)  (TTL = refresh TTL)
//	auth:subject:<kind>:<id>      → SET of session IDs     (housekeeping for revoke-all)
//	auth:active:<kind>            → ZSET sessionID → expiry unix seconds (active-session count)
//
// Refresh tokens are opaque random strings; only their SHA-256 is stored. Every refresh
// rotates the token. The previous token stays valid for a short grace window so two browser
// tabs refreshing at the same moment do not log each other out.
package session

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

type Kind string

const (
	KindUser  Kind = "user"
	KindAdmin Kind = "admin"
)

// RotationGrace is how long a just-rotated refresh token keeps working.
const RotationGrace = 30 * time.Second

var ErrNotFound = errors.New("session: not found or expired")

type Session struct {
	ID        string    `json:"id"`
	Kind      Kind      `json:"kind"`
	SubjectID string    `json:"subjectId"`
	CreatedAt time.Time `json:"createdAt"`
	IP        string    `json:"ip,omitempty"`
	UserAgent string    `json:"userAgent,omitempty"`
	Rotated   bool      `json:"rotated,omitempty"`
}

type Store struct {
	rdb *redis.Client
	ttl time.Duration
	now func() time.Time
}

func NewStore(rdb *redis.Client, refreshTTL time.Duration) *Store {
	return &Store{rdb: rdb, ttl: refreshTTL, now: time.Now}
}

func (s *Store) TTL() time.Duration { return s.ttl }

func refreshKey(hash string) string { return "auth:refresh:" + hash }
func sidKey(id string) string       { return "auth:sid:" + id }
func subjectKey(kind Kind, subject string) string {
	return fmt.Sprintf("auth:subject:%s:%s", kind, subject)
}
func activeKey(kind Kind) string { return "auth:active:" + string(kind) }

func randomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func hashToken(t string) string {
	sum := sha256.Sum256([]byte(t))
	return hex.EncodeToString(sum[:])
}

// Create starts a new session and returns its refresh token.
func (s *Store) Create(ctx context.Context, kind Kind, subjectID, ip, userAgent string) (string, Session, error) {
	id, err := randomToken()
	if err != nil {
		return "", Session{}, err
	}
	sess := Session{ID: id[:22], Kind: kind, SubjectID: subjectID, CreatedAt: s.now().UTC(), IP: ip, UserAgent: truncate(userAgent, 256)}
	tok, err := s.write(ctx, sess)
	return tok, sess, err
}

func (s *Store) write(ctx context.Context, sess Session) (string, error) {
	tok, err := randomToken()
	if err != nil {
		return "", err
	}
	body, err := json.Marshal(sess)
	if err != nil {
		return "", err
	}
	h := hashToken(tok)
	expiresAt := s.now().Add(s.ttl).Unix()
	_, err = s.rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.Set(ctx, refreshKey(h), body, s.ttl)
		p.Set(ctx, sidKey(sess.ID), h, s.ttl)
		p.SAdd(ctx, subjectKey(sess.Kind, sess.SubjectID), sess.ID)
		p.Expire(ctx, subjectKey(sess.Kind, sess.SubjectID), s.ttl)
		p.ZAdd(ctx, activeKey(sess.Kind), redis.Z{Score: float64(expiresAt), Member: sess.ID})
		return nil
	})
	return tok, err
}

// Get returns the session for a refresh token without rotating it.
func (s *Store) Get(ctx context.Context, kind Kind, refreshToken string) (Session, error) {
	raw, err := s.rdb.Get(ctx, refreshKey(hashToken(refreshToken))).Bytes()
	if errors.Is(err, redis.Nil) {
		return Session{}, ErrNotFound
	}
	if err != nil {
		return Session{}, err
	}
	var sess Session
	if err := json.Unmarshal(raw, &sess); err != nil {
		return Session{}, err
	}
	if sess.Kind != kind {
		return Session{}, ErrNotFound
	}
	return sess, nil
}

// Rotate exchanges a refresh token for a new one (same session ID).
func (s *Store) Rotate(ctx context.Context, kind Kind, refreshToken string) (string, Session, error) {
	sess, err := s.Get(ctx, kind, refreshToken)
	if err != nil {
		return "", Session{}, err
	}
	// A session revoked via logout/revoke-all has no sid pointer any more.
	if n, err := s.rdb.Exists(ctx, sidKey(sess.ID)).Result(); err != nil {
		return "", Session{}, err
	} else if n == 0 {
		return "", Session{}, ErrNotFound
	}

	oldKey := refreshKey(hashToken(refreshToken))
	if !sess.Rotated {
		marked := sess
		marked.Rotated = true
		body, _ := json.Marshal(marked)
		if err := s.rdb.Set(ctx, oldKey, body, RotationGrace).Err(); err != nil {
			return "", Session{}, err
		}
	}
	sess.Rotated = false
	tok, err := s.write(ctx, sess)
	return tok, sess, err
}

// Revoke ends the session that owns refreshToken. Unknown tokens are ignored.
func (s *Store) Revoke(ctx context.Context, kind Kind, refreshToken string) (Session, error) {
	sess, err := s.Get(ctx, kind, refreshToken)
	if err != nil {
		return Session{}, err
	}
	return sess, s.revokeID(ctx, sess.Kind, sess.SubjectID, sess.ID, hashToken(refreshToken))
}

func (s *Store) revokeID(ctx context.Context, kind Kind, subjectID, sessionID, extraHash string) error {
	current, err := s.rdb.Get(ctx, sidKey(sessionID)).Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		return err
	}
	_, err = s.rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		if current != "" {
			p.Del(ctx, refreshKey(current))
		}
		if extraHash != "" {
			p.Del(ctx, refreshKey(extraHash))
		}
		p.Del(ctx, sidKey(sessionID))
		p.SRem(ctx, subjectKey(kind, subjectID), sessionID)
		p.ZRem(ctx, activeKey(kind), sessionID)
		return nil
	})
	return err
}

// RevokeSubject ends every session of a subject except keepSessionID (may be empty).
func (s *Store) RevokeSubject(ctx context.Context, kind Kind, subjectID, keepSessionID string) (int, error) {
	ids, err := s.rdb.SMembers(ctx, subjectKey(kind, subjectID)).Result()
	if err != nil {
		return 0, err
	}
	n := 0
	for _, id := range ids {
		if id == keepSessionID {
			continue
		}
		if err := s.revokeID(ctx, kind, subjectID, id, ""); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// CountActive returns the number of non-expired sessions of a kind.
func (s *Store) CountActive(ctx context.Context, kind Kind) (int64, error) {
	now := strconv.FormatInt(s.now().Unix(), 10)
	if err := s.rdb.ZRemRangeByScore(ctx, activeKey(kind), "-inf", now).Err(); err != nil {
		return 0, err
	}
	return s.rdb.ZCard(ctx, activeKey(kind)).Result()
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
