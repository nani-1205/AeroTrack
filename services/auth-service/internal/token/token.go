// Package token issues RS256 access tokens and publishes the matching JWKS.
//
// User and admin tokens carry different audiences, so the gateway can never accept a user
// token on an admin route (or vice versa).
package token

import (
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type Role string

const (
	RoleUser  Role = "user"
	RoleAdmin Role = "admin"
)

// Claims are the access-token claims. Keep them minimal — profile data comes from /me.
type Claims struct {
	jwt.RegisteredClaims
	Role      Role   `json:"role"`
	SessionID string `json:"sid"`
	// MustChangePassword (admins only) restricts the token to the account endpoints.
	MustChangePassword bool `json:"mcp,omitempty"`
}

type Options struct {
	Issuer        string
	UserAudience  string
	AdminAudience string
	AccessTTL     time.Duration
}

type Issuer struct {
	key  *rsa.PrivateKey
	kid  string
	opts Options
	jwks []byte
	now  func() time.Time
}

// LoadIssuer reads the PKCS#8 private key and checks the public key file belongs to it.
func LoadIssuer(privateKeyPath, publicKeyPath string, opts Options) (*Issuer, error) {
	key, err := readPrivateKey(privateKeyPath)
	if err != nil {
		return nil, err
	}
	if publicKeyPath != "" {
		pub, err := readPublicKey(publicKeyPath)
		if err != nil {
			return nil, err
		}
		if !pub.Equal(&key.PublicKey) {
			return nil, fmt.Errorf("JWT public key %s does not match private key %s", publicKeyPath, privateKeyPath)
		}
	}
	return NewIssuer(key, opts)
}

func NewIssuer(key *rsa.PrivateKey, opts Options) (*Issuer, error) {
	if key.N.BitLen() < 2048 {
		return nil, errors.New("JWT signing key must be at least 2048 bits")
	}
	kid := thumbprint(&key.PublicKey)
	jwks, err := json.Marshal(map[string]any{"keys": []map[string]string{{
		"kty": "RSA", "use": "sig", "alg": "RS256", "kid": kid,
		"n": b64url(key.N.Bytes()), "e": b64url(big.NewInt(int64(key.E)).Bytes()),
	}}})
	if err != nil {
		return nil, err
	}
	return &Issuer{key: key, kid: kid, opts: opts, jwks: jwks, now: time.Now}, nil
}

func (i *Issuer) JWKS() []byte { return i.jwks }

func (i *Issuer) AccessTTL() time.Duration { return i.opts.AccessTTL }

func (i *Issuer) audience(role Role) string {
	if role == RoleAdmin {
		return i.opts.AdminAudience
	}
	return i.opts.UserAudience
}

// Issue signs an access token for subject (user/admin UUID) bound to a session.
func (i *Issuer) Issue(subject, sessionID string, role Role, mustChangePassword bool) (string, time.Time, error) {
	now := i.now()
	exp := now.Add(i.opts.AccessTTL)
	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    i.opts.Issuer,
			Subject:   subject,
			Audience:  jwt.ClaimStrings{i.audience(role)},
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(exp),
		},
		Role:               role,
		SessionID:          sessionID,
		MustChangePassword: mustChangePassword,
	}
	t := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	t.Header["kid"] = i.kid
	signed, err := t.SignedString(i.key)
	return signed, exp, err
}

// Verify validates a token for the given role. The gateway does this in production; this is
// used by tests and internal tooling.
func (i *Issuer) Verify(raw string, role Role) (*Claims, error) {
	var c Claims
	_, err := jwt.ParseWithClaims(raw, &c, func(*jwt.Token) (any, error) { return &i.key.PublicKey, nil },
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(i.opts.Issuer),
		jwt.WithAudience(i.audience(role)),
		jwt.WithExpirationRequired(),
		jwt.WithTimeFunc(i.now),
	)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// thumbprint is the RFC 7638 JWK thumbprint, used as a stable key id.
func thumbprint(pub *rsa.PublicKey) string {
	canonical := fmt.Sprintf(`{"e":"%s","kty":"RSA","n":"%s"}`,
		b64url(big.NewInt(int64(pub.E)).Bytes()), b64url(pub.N.Bytes()))
	sum := sha256.Sum256([]byte(canonical))
	return b64url(sum[:])
}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func readPEM(path string) (*pem.Block, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read key %s: %w", path, err)
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, fmt.Errorf("key %s is not PEM encoded", path)
	}
	return block, nil
}

func readPrivateKey(path string) (*rsa.PrivateKey, error) {
	block, err := readPEM(path)
	if err != nil {
		return nil, err
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse private key %s: %w", path, err)
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("private key %s is not RSA", path)
	}
	return key, nil
}

func readPublicKey(path string) (*rsa.PublicKey, error) {
	block, err := readPEM(path)
	if err != nil {
		return nil, err
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse public key %s: %w", path, err)
	}
	key, ok := parsed.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("public key %s is not RSA", path)
	}
	return key, nil
}
