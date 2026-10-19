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

// tunnelsTo counts every tunnel of the member to an address, the main one and any second one.
func tunnelsTo(control *nebula.Control, vpn netip.Addr) int {
	n := 0
	for _, h := range control.ListHostmapIndexes(false) {
		if len(h.VpnAddrs) > 0 && h.VpnAddrs[0] == vpn && h.CurrentRemote.IsValid() {
			n++
		}
	}
	return n
}

// reloadDropsHost starts a host that stays allowed and `copies` nodes of one host (the same overlay address, own
// certificates, as after a renewal) on 127.0.0.2 and up, connects a member to all of them, then takes 127.0.0.2 and
// up off the member's remote allow list and reloads it.
func reloadDropsHost(t *testing.T, copies int) (control *nebula.Control, cfg *config.C, kept, dropped netip.Addr) {
	dir := t.TempDir()
	if _, err := cmdCA([]string{"-name", "test", "-network", "10.98.0.0/24", "-out-crt", filepath.Join(dir, "ca.crt"), "-out-key", filepath.Join(dir, "ca.key")}); err != nil {
		t.Fatal(err)
	}
	keptIP := net.IPv4(127, 0, 0, 1)
	keptPort := freeUDPPortOn(t, keptIP)
	startNode(t, dir, "kept", "10.98.0.1", m{"listen": m{"host": keptIP.String(), "port": keptPort}})
	var droppedAddrs []string
	for i := range copies {
		ip := net.IPv4(127, 0, 0, byte(2+i))
		port := freeUDPPortOn(t, ip)
		startNode(t, dir, "dropped"+itoa(i), "10.98.0.2", m{"listen": m{"host": ip.String(), "port": port}})
		droppedAddrs = append(droppedAddrs, ip.String()+":"+itoa(port))
	}

	crt, key := issue(t, dir, "member", "10.98.0.3")
	write := func(allowDropped bool) string {
		allow := m{"0.0.0.0/0": false, "127.0.0.1/32": true, "127.0.0.0/8": allowDropped}
		raw, _ := json.Marshal(m{
			"pki":             m{"ca": filepath.Join(dir, "ca.crt"), "cert": crt, "key": key},
			"listen":          m{"host": "127.0.0.1", "port": 0},
			"static_host_map": m{"10.98.0.1": []string{keptIP.String() + ":" + itoa(keptPort)}, "10.98.0.2": droppedAddrs},
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
	cfg = config.NewC(logging.NewLogger(os.Stderr))
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

	kept, dropped = netip.MustParseAddr("10.98.0.1"), netip.MustParseAddr("10.98.0.2")
	deadline := time.Now().Add(15 * time.Second)
	for tunnelsTo(control, kept) == 0 || tunnelsTo(control, dropped) < copies {
		if time.Now().After(deadline) {
			t.Fatalf("the member never got its tunnels: kept %d, dropped %d of %d", tunnelsTo(control, kept), tunnelsTo(control, dropped), copies)
		}
		control.CreateTunnel(kept)
		control.CreateTunnel(dropped)
		time.Sleep(200 * time.Millisecond)
	}

	write(false)
	cfg.ReloadConfig()
	// The reload alone keeps the tunnels; without this check the test would prove nothing.
	if tunnelsTo(control, dropped) < copies {
		t.Fatal("expected the reload to keep the tunnels to the dropped host")
	}
	return control, cfg, kept, dropped
}

// A host taken off the lighthouses and relays leaves the member's remote allow list, but a reload alone keeps its
// tunnel: the member went on talking to it directly. closeDisallowed closes it and leaves the allowed one alone.
func TestReloadClosesTunnelsNoLongerAllowed(t *testing.T) {
	control, cfg, kept, dropped := reloadDropsHost(t, 1)
	n, err := closeDisallowed(control, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 || tunnelsTo(control, dropped) != 0 {
		t.Fatalf("closed %d tunnel(s); %d left to the dropped host", n, tunnelsTo(control, dropped))
	}
	if tunnelsTo(control, kept) == 0 {
		t.Fatal("the tunnel to the host still allowed was closed")
	}
}

// With a second tunnel to the same address, closing only the main one let the second take over and carry on.
func TestReloadClosesEverySecondTunnelToo(t *testing.T) {
	control, cfg, kept, dropped := reloadDropsHost(t, 2)
	if _, err := closeDisallowed(control, cfg); err != nil {
		t.Fatal(err)
	}
	if left := tunnelsTo(control, dropped); left != 0 {
		t.Fatalf("%d tunnel(s) left to the dropped host", left)
	}
	if n := tunnelsTo(control, kept); n == 0 {
		t.Fatal("the tunnel to the host still allowed was closed")
	}
}
