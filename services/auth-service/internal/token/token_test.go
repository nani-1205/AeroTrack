package token

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"testing"
	"time"
)

func newTestIssuer(t *testing.T) *Issuer {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	iss, err := NewIssuer(key, Options{Issuer: "aerotrack-auth", UserAudience: "aerotrack-user", AdminAudience: "aerotrack-admin", AccessTTL: 15 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	return iss
}

func TestIssueAndVerifyRoundTrip(t *testing.T) {
	iss := newTestIssuer(t)
	raw, exp, err := iss.Issue("user-1", "sess-1", RoleUser, false)
	if err != nil {
		t.Fatal(err)
	}
	if time.Until(exp) <= 14*time.Minute {
		t.Fatalf("unexpected expiry %v", exp)
	}
	c, err := iss.Verify(raw, RoleUser)
	if err != nil {
		t.Fatal(err)
	}
	if c.Subject != "user-1" || c.SessionID != "sess-1" || c.Role != RoleUser {
		t.Fatalf("unexpected claims %+v", c)
	}
}

func TestUserTokenIsRejectedForAdminAudience(t *testing.T) {
	iss := newTestIssuer(t)
	raw, _, _ := iss.Issue("user-1", "sess-1", RoleUser, false)
	if _, err := iss.Verify(raw, RoleAdmin); err == nil {
		t.Fatal("user token must not verify as admin")
	}
}

func TestExpiredTokenIsRejected(t *testing.T) {
	iss := newTestIssuer(t)
	iss.now = func() time.Time { return time.Now().Add(-time.Hour) }
	raw, _, _ := iss.Issue("admin-1", "sess-1", RoleAdmin, true)
	iss.now = time.Now
	if _, err := iss.Verify(raw, RoleAdmin); err == nil {
		t.Fatal("expired token must be rejected")
	}
}

func TestJWKSContainsSigningKey(t *testing.T) {
	iss := newTestIssuer(t)
	var doc struct {
		Keys []map[string]string `json:"keys"`
	}
	if err := json.Unmarshal(iss.JWKS(), &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Keys) != 1 || doc.Keys[0]["kid"] != iss.kid || doc.Keys[0]["alg"] != "RS256" || doc.Keys[0]["e"] != "AQAB" {
		t.Fatalf("unexpected JWKS %s", iss.JWKS())
	}
}
