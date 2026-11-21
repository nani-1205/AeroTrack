package password

import (
	"strings"
	"testing"
)

// Cheap params keep the test fast; the format and verification path are identical.
var fast = Params{Memory: 1024, Iterations: 1, Parallelism: 1, SaltLength: 16, KeyLength: 32}

func TestHashAndVerify(t *testing.T) {
	h, err := hashWith("correct horse battery staple", fast)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "$argon2id$v=19$m=1024,t=1,p=1$") {
		t.Fatalf("unexpected encoding: %s", h)
	}
	ok, err := Verify("correct horse battery staple", h)
	if err != nil || !ok {
		t.Fatalf("expected match, got ok=%v err=%v", ok, err)
	}
	ok, err = Verify("wrong password", h)
	if err != nil || ok {
		t.Fatalf("expected mismatch, got ok=%v err=%v", ok, err)
	}
}

func TestHashUsesRandomSalt(t *testing.T) {
	a, _ := hashWith("same", fast)
	b, _ := hashWith("same", fast)
	if a == b {
		t.Fatal("two hashes of the same password must differ (random salt)")
	}
}

func TestVerifyRejectsMalformedHashes(t *testing.T) {
	for _, h := range []string{"", "plain", "$argon2i$v=19$m=1,t=1,p=1$c2FsdA$a2V5", "$argon2id$v=18$m=1,t=1,p=1$c2FsdA$a2V5", "$argon2id$v=19$bad$c2FsdA$a2V5"} {
		if _, err := Verify("x", h); err == nil {
			t.Errorf("expected ErrInvalidHash for %q", h)
		}
	}
}

func TestValidate(t *testing.T) {
	cases := map[string]bool{
		"short":                    false,
		"exactly-12ch":             true,
		" leading-space-password":  false,
		strings.Repeat("a", 129):   false,
		"a perfectly fine passwd!": true,
	}
	for pw, wantOK := range cases {
		if err := Validate(pw, 12); (err == nil) != wantOK {
			t.Errorf("Validate(%q) err=%v, want ok=%v", pw, err, wantOK)
		}
	}
}
