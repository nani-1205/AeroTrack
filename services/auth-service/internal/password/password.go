// Package password hashes and verifies admin passwords with argon2id (PHC string format).
package password

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"

	"golang.org/x/crypto/argon2"
)

// MaxLength caps input size so a huge password cannot be used to burn CPU/memory.
const MaxLength = 128

var ErrInvalidHash = errors.New("password: invalid hash format")

type Params struct {
	Memory      uint32 // KiB
	Iterations  uint32
	Parallelism uint8
	SaltLength  uint32
	KeyLength   uint32
}

// Default follows OWASP guidance for argon2id (≥19 MiB, t≥2); we use 64 MiB, t=3, p=2.
var Default = Params{Memory: 64 * 1024, Iterations: 3, Parallelism: 2, SaltLength: 16, KeyLength: 32}

var b64 = base64.RawStdEncoding

// Hash returns an encoded argon2id hash: $argon2id$v=19$m=..,t=..,p=..$<salt>$<key>.
func Hash(plain string) (string, error) {
	return hashWith(plain, Default)
}

func hashWith(plain string, p Params) (string, error) {
	salt := make([]byte, p.SaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(plain), salt, p.Iterations, p.Memory, p.Parallelism, p.KeyLength)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, p.Memory, p.Iterations, p.Parallelism, b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

// Verify reports whether plain matches the encoded hash, in constant time.
func Verify(plain, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, ErrInvalidHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, ErrInvalidHash
	}
	var p Params
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.Memory, &p.Iterations, &p.Parallelism); err != nil {
		return false, ErrInvalidHash
	}
	salt, err := b64.DecodeString(parts[4])
	if err != nil {
		return false, ErrInvalidHash
	}
	want, err := b64.DecodeString(parts[5])
	if err != nil || len(want) == 0 {
		return false, ErrInvalidHash
	}
	got := argon2.IDKey([]byte(plain), salt, p.Iterations, p.Memory, p.Parallelism, uint32(len(want)))
	return subtle.ConstantTimeCompare(want, got) == 1, nil
}

var (
	dummyOnce sync.Once
	dummyHash string
)

// VerifyDummy burns the same time as a real verification. Call it when the account does not
// exist so response timing does not reveal which usernames are valid.
func VerifyDummy(plain string) {
	dummyOnce.Do(func() { dummyHash, _ = Hash("aerotrack-timing-equaliser") })
	_, _ = Verify(plain, dummyHash)
}

// Validate enforces the admin password policy.
func Validate(plain string, minLength int) error {
	n := len([]rune(plain))
	switch {
	case n < minLength:
		return fmt.Errorf("password must be at least %d characters", minLength)
	case len(plain) > MaxLength:
		return fmt.Errorf("password must be at most %d bytes", MaxLength)
	case strings.TrimSpace(plain) != plain:
		return errors.New("password must not start or end with whitespace")
	}
	return nil
}
