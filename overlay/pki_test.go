package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A member approved again after it was revoked by peer ID gets a certificate that starts after the revocation, so
// the revocation keeps covering every older certificate of the node.
func TestSignStartsAtNotBefore(t *testing.T) {
	dir := t.TempDir()
	if _, err := cmdCA([]string{"-name", "test", "-network", "10.97.0.0/24", "-out-crt", filepath.Join(dir, "ca.crt"), "-out-key", filepath.Join(dir, "ca.key")}); err != nil {
		t.Fatal(err)
	}
	out, err := cmdKeygen([]string{"-out-key", filepath.Join(dir, "m.key")})
	if err != nil {
		t.Fatal(err)
	}
	pub := filepath.Join(dir, "m.pub")
	if err := os.WriteFile(pub, []byte(out.(map[string]string)["publicKey"]), 0o600); err != nil {
		t.Fatal(err)
	}
	from := time.Now().Add(-10 * time.Second).UTC().Truncate(time.Second)
	until := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	sign := func(extra ...string) (any, error) {
		args := []string{"-ca-crt", filepath.Join(dir, "ca.crt"), "-ca-key", filepath.Join(dir, "ca.key"), "-public-key", pub, "-name", "m", "-ip", "10.97.0.5/24", "-not-after", until, "-out-crt", filepath.Join(dir, "m"+itoa(len(extra))+".crt")}
		return cmdSign(append(args, extra...))
	}
	info, err := sign("-not-before", from.Format(time.RFC3339))
	if err != nil {
		t.Fatal(err)
	}
	if got := info.(*certInfo).NotBefore; got != from.Format(time.RFC3339) {
		t.Fatalf("notBefore = %s, want %s", got, from.Format(time.RFC3339))
	}
	if _, err := sign("-not-before", time.Now().Add(2*time.Hour).UTC().Format(time.RFC3339)); err == nil {
		t.Fatal("a start after the expiry was accepted")
	}
}
