package main

import (
	"encoding/json"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/slackhq/nebula"
	"github.com/slackhq/nebula/config"
	"github.com/slackhq/nebula/logging"
	"github.com/slackhq/nebula/overlay"
)

type m = map[string]any

func freeUDPPort(t *testing.T) int {
	t.Helper()
	c, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	return c.LocalAddr().(*net.UDPAddr).Port
}

// issue signs a member certificate for vpnIP through the same commands the backend uses.
func issue(t *testing.T, dir, name, vpnIP string) (crt, key string) {
	t.Helper()
	key = filepath.Join(dir, name+".key")
	out, err := cmdKeygen([]string{"-out-key", key})
	if err != nil {
		t.Fatal(err)
	}
	pub := filepath.Join(dir, name+".pub")
	if err := os.WriteFile(pub, []byte(out.(map[string]string)["publicKey"]), 0o600); err != nil {
		t.Fatal(err)
	}
	crt = filepath.Join(dir, name+".crt")
	until := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	if _, err := cmdSign([]string{"-ca-crt", filepath.Join(dir, "ca.crt"), "-ca-key", filepath.Join(dir, "ca.key"), "-public-key", pub, "-name", name, "-ip", vpnIP + "/24", "-groups", "member", "-not-after", until, "-out-crt", crt}); err != nil {
		t.Fatal(err)
	}
	return crt, key
}

func startNode(t *testing.T, dir, name, vpnIP string, extra m) *nebula.Control {
	t.Helper()
	crt, key := issue(t, dir, name, vpnIP)
	cfg := m{
		"pki":        m{"ca": filepath.Join(dir, "ca.crt"), "cert": crt, "key": key},
		"firewall":   m{"outbound": []m{{"port": "any", "proto": "any", "host": "any"}}, "inbound": []m{{"port": "any", "proto": "any", "host": "any"}}},
		"handshakes": m{"try_interval": "200ms"},
		"logging":    m{"level": "error"},
	}
	for k, v := range extra {
		cfg[k] = v
	}
	raw, _ := json.Marshal(cfg)
	var c config.C
	if err := c.LoadString(string(raw)); err != nil {
		t.Fatal(err)
	}
	control, err := nebula.Main(&c, false, "test", logging.NewLogger(os.Stderr), overlay.NewUserDeviceFromConfig)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := newNetstack(control, 9090, func(c net.Conn) { c.Close() }); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(control.Stop)
	return control
}

// queryMember asks the lighthouse about member b from member a and returns what a was told.
func queryMember(t *testing.T, hide bool) *nebula.Cache {
	dir := t.TempDir()
	if _, err := cmdCA([]string{"-name", "test", "-network", "10.99.0.0/24", "-out-crt", filepath.Join(dir, "ca.crt"), "-out-key", filepath.Join(dir, "ca.key")}); err != nil {
		t.Fatal(err)
	}
	lhPort := freeUDPPort(t)
	lhAddr := "127.0.0.1:" + itoa(lhPort)
	startNode(t, dir, "lh", "10.99.0.1", m{
		"listen":     m{"host": "127.0.0.1", "port": lhPort},
		"lighthouse": m{"am_lighthouse": true, "hide_addresses": hide},
		"relay":      m{"am_relay": true},
	})
	member := func(name, ip string) *nebula.Control {
		return startNode(t, dir, name, ip, m{
			"listen":          m{"host": "127.0.0.1", "port": 0},
			"static_host_map": m{"10.99.0.1": []string{lhAddr}},
			// Report nothing, so the only address the lighthouse can know is the one it learned from packets.
			"lighthouse": m{"hosts": []string{"10.99.0.1"}, "interval": 1, "local_allow_list": m{"0.0.0.0/0": false}},
			"relay":      m{"relays": []string{"10.99.0.1"}, "use_relays": true},
		})
	}
	member("b", "10.99.0.3")
	a := member("a", "10.99.0.2")
	b := netip.MustParseAddr("10.99.0.3")
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		// The relay entry comes with every answer, so its presence means the lighthouse has replied.
		if c := a.QueryLighthouse(b); c != nil {
			for _, entry := range *c {
				if len(entry.Relay) > 0 {
					return entry
				}
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("the lighthouse never answered with the member's relay")
	return nil
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

// With hide_addresses a member learns only the relays of another member, never its underlay address.
func TestLighthouseHidesMemberAddresses(t *testing.T) {
	c := queryMember(t, true)
	if len(c.Learned) != 0 || len(c.Reported) != 0 {
		t.Fatalf("hidden lighthouse leaked addresses: learned=%v reported=%v", c.Learned, c.Reported)
	}
}

// Control: the same setup without the option gives the address away, so the test above is not vacuous.
func TestLighthouseWithoutHideRevealsAddresses(t *testing.T) {
	c := queryMember(t, false)
	if len(c.Learned)+len(c.Reported) == 0 {
		t.Fatal("expected the stock lighthouse to answer with the member's address")
	}
}
