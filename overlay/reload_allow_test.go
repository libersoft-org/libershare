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

func freeUDPPortOn(t *testing.T, ip net.IP) int {
	t.Helper()
	c, err := net.ListenUDP("udp4", &net.UDPAddr{IP: ip})
	if err != nil {
		t.Skipf("cannot listen on %s: %v", ip, err)
	}
	defer c.Close()
	return c.LocalAddr().(*net.UDPAddr).Port
}

// A host taken off the lighthouses and relays leaves the member's remote allow list, but a reload alone keeps its
// tunnel: the member went on talking to it directly. closeDisallowed closes it and leaves the allowed one alone.
func TestReloadClosesTunnelsNoLongerAllowed(t *testing.T) {
	dir := t.TempDir()
	if _, err := cmdCA([]string{"-name", "test", "-network", "10.98.0.0/24", "-out-crt", filepath.Join(dir, "ca.crt"), "-out-key", filepath.Join(dir, "ca.key")}); err != nil {
		t.Fatal(err)
	}
	keptIP, droppedIP := net.IPv4(127, 0, 0, 1), net.IPv4(127, 0, 0, 2)
	keptPort, droppedPort := freeUDPPortOn(t, keptIP), freeUDPPortOn(t, droppedIP)
	startNode(t, dir, "kept", "10.98.0.1", m{"listen": m{"host": keptIP.String(), "port": keptPort}})
	startNode(t, dir, "dropped", "10.98.0.2", m{"listen": m{"host": droppedIP.String(), "port": droppedPort}})

	crt, key := issue(t, dir, "member", "10.98.0.3")
	write := func(allowDropped bool) string {
		allow := m{"0.0.0.0/0": false, "127.0.0.1/32": true, "127.0.0.2/32": allowDropped}
		raw, _ := json.Marshal(m{
			"pki":             m{"ca": filepath.Join(dir, "ca.crt"), "cert": crt, "key": key},
			"listen":          m{"host": "127.0.0.1", "port": 0},
			"static_host_map": m{"10.98.0.1": []string{keptIP.String() + ":" + itoa(keptPort)}, "10.98.0.2": []string{droppedIP.String() + ":" + itoa(droppedPort)}},
			"lighthouse":      m{"remote_allow_list": allow},
			"firewall":        m{"outbound": []m{{"port": "any", "proto": "any", "host": "any"}}, "inbound": []m{{"port": "any", "proto": "any", "host": "any"}}},
			"handshakes":      m{"try_interval": "200ms"},
			"logging":         m{"level": "error"},
		})
		path := filepath.Join(dir, "member.json")
		if err := os.WriteFile(path, raw, 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	cfg := config.NewC(logging.NewLogger(os.Stderr))
	if err := cfg.Load(write(true)); err != nil {
		t.Fatal(err)
	}
	control, err := nebula.Main(cfg, false, "test", logging.NewLogger(os.Stderr), overlay.NewUserDeviceFromConfig)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := newNetstack(control, 9090, func(c net.Conn) { c.Close() }); err != nil {
		t.Fatal(err)
	}
	control.Start()
	t.Cleanup(control.Stop)

	kept, dropped := netip.MustParseAddr("10.98.0.1"), netip.MustParseAddr("10.98.0.2")
	up := func(vpn netip.Addr) bool {
		h := control.GetHostInfoByVpnAddr(vpn, false)
		return h != nil && h.CurrentRemote.IsValid()
	}
	deadline := time.Now().Add(15 * time.Second)
	for !(up(kept) && up(dropped)) {
		if time.Now().After(deadline) {
			t.Fatal("the member never got tunnels to both hosts")
		}
		control.CreateTunnel(kept)
		control.CreateTunnel(dropped)
		time.Sleep(200 * time.Millisecond)
	}

	write(false)
	cfg.ReloadConfig()
	// The reload alone keeps the tunnel; without this check the test would prove nothing.
	if !up(dropped) {
		t.Fatal("expected the reload to keep the tunnel to the dropped host")
	}
	n, err := closeDisallowed(control, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 || control.GetHostInfoByVpnAddr(dropped, false) != nil {
		t.Fatalf("closed %d tunnel(s); dropped host still has one: %v", n, control.GetHostInfoByVpnAddr(dropped, false) != nil)
	}
	if !up(kept) {
		t.Fatal("the tunnel to the host still allowed was closed")
	}
}
