package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"net/netip"
	"os"
	"strings"
	"time"

	"github.com/slackhq/nebula/cert"
	"golang.org/x/crypto/curve25519"
)

// certInfo is the public description of a certificate, as the backend reads it.
type certInfo struct {
	Cert        string   `json:"cert"`
	Name        string   `json:"name"`
	Networks    []string `json:"networks"`
	Groups      []string `json:"groups"`
	IsCA        bool     `json:"isCA"`
	NotBefore   string   `json:"notBefore"`
	NotAfter    string   `json:"notAfter"`
	Issuer      string   `json:"issuer"`
	Fingerprint string   `json:"fingerprint"`
	PublicKey   string   `json:"publicKey"`
}

func describe(c cert.Certificate) (*certInfo, error) {
	pem, err := c.MarshalPEM()
	if err != nil {
		return nil, err
	}
	fp, err := c.Fingerprint()
	if err != nil {
		return nil, err
	}
	networks := []string{}
	for _, n := range c.Networks() {
		networks = append(networks, n.String())
	}
	groups := c.Groups()
	if groups == nil {
		groups = []string{}
	}
	return &certInfo{
		Cert:        string(pem),
		Name:        c.Name(),
		Networks:    networks,
		Groups:      groups,
		IsCA:        c.IsCA(),
		NotBefore:   c.NotBefore().UTC().Format(time.RFC3339),
		NotAfter:    c.NotAfter().UTC().Format(time.RFC3339),
		Issuer:      c.Issuer(),
		Fingerprint: fp,
		PublicKey:   hex.EncodeToString(c.PublicKey()),
	}, nil
}

// writeNew writes a file that must not exist yet, readable by the owner only: a key is never overwritten.
func writeNew(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func readCert(path string) (cert.Certificate, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	c, _, err := cert.UnmarshalCertificateFromPEM(b)
	return c, err
}

// cmdCA creates a network's certificate authority: an ed25519 signing key and a v2 CA certificate whose
// network constrains every member address to the protected network's subnet.
func cmdCA(args []string) (any, error) {
	fs := flag.NewFlagSet("ca", flag.ContinueOnError)
	name := fs.String("name", "", "CA name")
	network := fs.String("network", "", "subnet every member address must lie in, e.g. 100.64.0.0/16")
	duration := fs.Duration("duration", 10*365*24*time.Hour, "validity of the CA")
	outCrt := fs.String("out-crt", "", "CA certificate path")
	outKey := fs.String("out-key", "", "CA signing key path")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if err := required(fs, "name", "network", "out-crt", "out-key"); err != nil {
		return nil, err
	}
	subnet, err := netip.ParsePrefix(*network)
	if err != nil || !subnet.Addr().Is4() || subnet.Masked() != subnet {
		return nil, fmt.Errorf("-network must be an IPv4 subnet such as 100.64.0.0/16, got %q", *network)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	t := &cert.TBSCertificate{
		Version:   cert.Version2,
		Name:      *name,
		Networks:  []netip.Prefix{subnet},
		IsCA:      true,
		NotBefore: now.Add(-time.Minute),
		NotAfter:  now.Add(*duration),
		PublicKey: pub,
		Curve:     cert.Curve_CURVE25519,
	}
	c, err := t.Sign(nil, cert.Curve_CURVE25519, priv)
	if err != nil {
		return nil, err
	}
	info, err := describe(c)
	if err != nil {
		return nil, err
	}
	if err := writeNew(*outKey, cert.MarshalSigningPrivateKeyToPEM(cert.Curve_CURVE25519, priv)); err != nil {
		return nil, err
	}
	if err := writeNew(*outCrt, []byte(info.Cert)); err != nil {
		return nil, err
	}
	return info, nil
}

// cmdKeygen creates a member's X25519 key pair. The private key stays in the file; only the public key is printed.
func cmdKeygen(args []string) (any, error) {
	fs := flag.NewFlagSet("keygen", flag.ContinueOnError)
	outKey := fs.String("out-key", "", "private key path")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if err := required(fs, "out-key"); err != nil {
		return nil, err
	}
	priv := make([]byte, 32)
	if _, err := rand.Read(priv); err != nil {
		return nil, err
	}
	pub, err := curve25519.X25519(priv, curve25519.Basepoint)
	if err != nil {
		return nil, err
	}
	if err := writeNew(*outKey, cert.MarshalPrivateKeyToPEM(cert.Curve_CURVE25519, priv)); err != nil {
		return nil, err
	}
	return map[string]string{"publicKey": string(cert.MarshalPublicKeyToPEM(cert.Curve_CURVE25519, pub))}, nil
}

// cmdSign issues a member certificate for a public key the member generated itself.
func cmdSign(args []string) (any, error) {
	fs := flag.NewFlagSet("sign", flag.ContinueOnError)
	caCrt := fs.String("ca-crt", "", "CA certificate path")
	caKey := fs.String("ca-key", "", "CA signing key path")
	pubPath := fs.String("public-key", "", "member public key (PEM) path")
	name := fs.String("name", "", "certificate name")
	ip := fs.String("ip", "", "member address with the subnet size, e.g. 100.64.0.2/16")
	groups := fs.String("groups", "", "comma separated groups")
	notAfter := fs.String("not-after", "", "expiry, RFC 3339")
	notBefore := fs.String("not-before", "", "optional start of validity, RFC 3339 (default: a minute ago)")
	outCrt := fs.String("out-crt", "", "certificate path")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if err := required(fs, "ca-crt", "ca-key", "public-key", "name", "ip", "not-after", "out-crt"); err != nil {
		return nil, err
	}
	ca, err := readCert(*caCrt)
	if err != nil {
		return nil, fmt.Errorf("CA certificate: %w", err)
	}
	keyPEM, err := os.ReadFile(*caKey)
	if err != nil {
		return nil, err
	}
	key, _, curve, err := cert.UnmarshalSigningPrivateKeyFromPEM(keyPEM)
	if err != nil {
		return nil, fmt.Errorf("CA key: %w", err)
	}
	if !ca.CheckSignature(ed25519.PrivateKey(key).Public().(ed25519.PublicKey)) {
		return nil, errors.New("the CA key does not belong to the CA certificate")
	}
	pubPEM, err := os.ReadFile(*pubPath)
	if err != nil {
		return nil, err
	}
	pub, _, pubCurve, err := cert.UnmarshalPublicKeyFromPEM(pubPEM)
	if err != nil {
		return nil, fmt.Errorf("member public key: %w", err)
	}
	if pubCurve != curve {
		return nil, errors.New("the member key uses another curve than the CA")
	}
	addr, err := netip.ParsePrefix(*ip)
	if err != nil {
		return nil, fmt.Errorf("-ip: %w", err)
	}
	until, err := time.Parse(time.RFC3339, *notAfter)
	if err != nil {
		return nil, fmt.Errorf("-not-after: %w", err)
	}
	if until.After(ca.NotAfter()) {
		return nil, fmt.Errorf("the certificate cannot outlive the CA (%s)", ca.NotAfter().UTC().Format(time.RFC3339))
	}
	// A minute back absorbs clock skew between members; an approval after a revocation of the same node starts after it.
	from := time.Now().Add(-time.Minute)
	if *notBefore != "" {
		if from, err = time.Parse(time.RFC3339, *notBefore); err != nil {
			return nil, fmt.Errorf("-not-before: %w", err)
		}
		if !from.Before(until) {
			return nil, errors.New("-not-before must be before -not-after")
		}
	}
	var groupList []string
	for _, g := range strings.Split(*groups, ",") {
		if g = strings.TrimSpace(g); g != "" {
			groupList = append(groupList, g)
		}
	}
	t := &cert.TBSCertificate{
		Version:   ca.Version(),
		Name:      *name,
		Networks:  []netip.Prefix{addr},
		Groups:    groupList,
		NotBefore: from,
		NotAfter:  until,
		PublicKey: pub,
		Curve:     curve,
	}
	c, err := t.Sign(ca, curve, key)
	if err != nil {
		return nil, err
	}
	if err := cert.CheckCAConstraints(ca, c); err != nil {
		return nil, err
	}
	info, err := describe(c)
	if err != nil {
		return nil, err
	}
	if err := writeNew(*outCrt, []byte(info.Cert)); err != nil {
		return nil, err
	}
	return info, nil
}

// cmdPrint describes a certificate. With -ca it also checks that the CA signed it.
func cmdPrint(args []string) (any, error) {
	fs := flag.NewFlagSet("print", flag.ContinueOnError)
	crt := fs.String("crt", "", "certificate path")
	caCrt := fs.String("ca", "", "optional CA certificate path to verify against")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if err := required(fs, "crt"); err != nil {
		return nil, err
	}
	c, err := readCert(*crt)
	if err != nil {
		return nil, err
	}
	if *caCrt != "" {
		ca, err := readCert(*caCrt)
		if err != nil {
			return nil, fmt.Errorf("CA certificate: %w", err)
		}
		if !c.CheckSignature(ca.PublicKey()) {
			return nil, errors.New("the certificate was not signed by this CA")
		}
		if err := cert.CheckCAConstraints(ca, c); err != nil {
			return nil, err
		}
	}
	return describe(c)
}
