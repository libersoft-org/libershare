package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/slackhq/nebula"
	"github.com/slackhq/nebula/config"
	"github.com/slackhq/nebula/logging"
	"github.com/slackhq/nebula/overlay"
)

const (
	headerTimeout = 10 * time.Second
	dialTimeout   = 20 * time.Second
	maxHeader     = 256
)

// bridge connects the overlay to the backend over loopback TCP. Every connection starts with one header line
// carrying the shared token, so no other local process can use either direction.
//
//	backend -> helper (dial port):    "<token> <overlay ip>:<port>\n", answered "OK\n" or "ERR <reason>\n"
//	helper -> backend (inbound port): "<token> <remote overlay ip>:<port>\n"
type bridge struct {
	token   string
	ns      *netstack
	control *nebula.Control
	cfg     *config.C
	log     *slog.Logger
	// inbound is the backend's loopback port for connections arriving from the overlay; 0 refuses them.
	inbound atomic.Int32
	stop    chan struct{}

	mu sync.Mutex
	// conns holds every bridged connection by its remote overlay address, so the connections of a peer whose tunnel
	// is gone (a revoked certificate) can be closed at once instead of waiting for a TCP timeout.
	conns map[net.Conn]netip.Addr
}

// track registers a bridged pair; the returned function forgets it.
func (b *bridge) track(remote netip.Addr, local, overlayConn net.Conn) func() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.conns[local] = remote
	b.conns[overlayConn] = remote
	return func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		delete(b.conns, local)
		delete(b.conns, overlayConn)
	}
}

// closeOrphans closes every bridged connection to a peer that no longer has a tunnel.
func (b *bridge) closeOrphans() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	closed := 0
	for c, remote := range b.conns {
		if b.control.GetHostInfoByVpnAddr(remote, false) == nil {
			c.Close()
			closed++
		}
	}
	return closed
}

func cmdRun(args []string) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	cfgPath := fs.String("config", "", "nebula configuration")
	port := fs.Int("port", 9090, "overlay TCP port the backend's node listens on")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := required(fs, "config"); err != nil {
		return err
	}
	token := os.Getenv("LISH_OVERLAY_TOKEN")
	if len(token) < 32 || strings.ContainsAny(token, " \r\n") {
		return errors.New("LISH_OVERLAY_TOKEN must hold at least 32 characters without spaces")
	}
	if *port <= 0 || *port > 65535 {
		return fmt.Errorf("invalid -port %d", *port)
	}
	var c config.C
	if err := c.Load(*cfgPath); err != nil {
		return err
	}
	log := logging.NewLogger(os.Stderr)
	control, err := nebula.Main(&c, false, version, log, overlay.NewUserDeviceFromConfig)
	if err != nil {
		return err
	}
	b := &bridge{token: token, control: control, cfg: &c, log: log, stop: make(chan struct{}), conns: map[net.Conn]netip.Addr{}}
	b.ns, err = newNetstack(control, uint16(*port), b.forwardInbound)
	if err != nil {
		return err
	}
	defer control.Stop()

	dialLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	go b.serveDial(dialLn)
	ctlLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	go http.Serve(ctlLn, b.controlHandler())

	ready, _ := json.Marshal(map[string]any{"event": "ready", "control": ctlLn.Addr().(*net.TCPAddr).Port, "dial": dialLn.Addr().(*net.TCPAddr).Port})
	fmt.Println(string(ready))

	// The backend holds our stdin open for as long as it wants us. When it exits, crashes or is killed, the pipe
	// closes and we follow, so no helper outlives its backend on any platform.
	parentGone := make(chan struct{})
	go func() {
		io.Copy(io.Discard, os.Stdin)
		close(parentGone)
	}()
	nebulaDone := make(chan error, 1)
	go func() { nebulaDone <- b.ns.eg.Wait() }()
	select {
	case <-parentGone:
		log.Info("backend closed the control pipe, stopping")
	case <-b.stop:
		log.Info("stop requested")
	case err := <-nebulaDone:
		return fmt.Errorf("nebula stopped: %v", err)
	}
	return nil
}

func (b *bridge) tokenOK(t string) bool {
	return subtle.ConstantTimeCompare([]byte(t), []byte(b.token)) == 1
}

// readHeader reads "<token> <rest>\n" one byte at a time, so nothing after the newline is consumed.
func readHeader(c net.Conn) (string, string, error) {
	c.SetReadDeadline(time.Now().Add(headerTimeout))
	defer c.SetReadDeadline(time.Time{})
	var line []byte
	one := make([]byte, 1)
	for {
		if _, err := c.Read(one); err != nil {
			return "", "", err
		}
		if one[0] == '\n' {
			break
		}
		if len(line) >= maxHeader {
			return "", "", errors.New("header too long")
		}
		line = append(line, one[0])
	}
	token, rest, ok := strings.Cut(string(line), " ")
	if !ok {
		return "", "", errors.New("malformed header")
	}
	return token, rest, nil
}

// serveDial accepts the backend's outbound connections and opens the requested overlay connection.
func (b *bridge) serveDial(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go b.handleDial(c)
	}
}

func (b *bridge) handleDial(local net.Conn) {
	token, target, err := readHeader(local)
	if err != nil || !b.tokenOK(token) {
		local.Close()
		return
	}
	to, err := netip.ParseAddrPort(target)
	if err != nil {
		fmt.Fprintf(local, "ERR bad address\n")
		local.Close()
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), dialTimeout)
	remote, err := b.ns.dial(ctx, to)
	cancel()
	if err != nil {
		fmt.Fprintf(local, "ERR %s\n", strings.ReplaceAll(err.Error(), "\n", " "))
		local.Close()
		return
	}
	if _, err := io.WriteString(local, "OK\n"); err != nil {
		local.Close()
		remote.Close()
		return
	}
	defer b.track(to.Addr(), local, remote)()
	pipe(local, remote)
}

// forwardInbound hands a connection that arrived from the overlay to the backend.
func (b *bridge) forwardInbound(remote net.Conn) {
	port := b.inbound.Load()
	if port == 0 {
		remote.Close()
		return
	}
	local, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(int(port))), headerTimeout)
	if err != nil {
		remote.Close()
		return
	}
	if _, err := fmt.Fprintf(local, "%s %s\n", b.token, remote.RemoteAddr().String()); err != nil {
		local.Close()
		remote.Close()
		return
	}
	if from, err := netip.ParseAddrPort(remote.RemoteAddr().String()); err == nil {
		defer b.track(from.Addr(), local, remote)()
	}
	pipe(local, remote)
}

type closeWriter interface{ CloseWrite() error }

// pipe copies both ways. A clean end of one direction is passed on as a half close; an error closes both.
func pipe(a, b net.Conn) {
	done := make(chan error, 2)
	cp := func(dst, src net.Conn) {
		_, err := io.Copy(dst, src)
		if cw, ok := dst.(closeWriter); ok && err == nil {
			cw.CloseWrite()
		} else {
			dst.Close()
			src.Close()
		}
		done <- err
	}
	go cp(a, b)
	go cp(b, a)
	<-done
	<-done
	a.Close()
	b.Close()
}

// hostStatus describes one tunnel. Remote is the underlay address of a direct tunnel; for a member that is only
// ever an infrastructure node or a LAN neighbour (the lighthouse hides everything else).
type hostStatus struct {
	VpnAddrs   []string `json:"vpnAddrs"`
	Name       string   `json:"name"`
	Remote     string   `json:"remote,omitempty"`
	RelayedVia []string `json:"relayedVia"`
}

func (b *bridge) status() map[string]any {
	hosts := []hostStatus{}
	for _, h := range b.control.ListHostmapHosts(false) {
		// A tunnel whose relay dropped it (e.g. after this node was revoked) lingers with no path until it times out.
		if !h.CurrentRemote.IsValid() && len(h.CurrentRelaysToMe) == 0 {
			continue
		}
		hs := hostStatus{Name: h.Cert.Name(), RelayedVia: []string{}}
		for _, a := range h.VpnAddrs {
			hs.VpnAddrs = append(hs.VpnAddrs, a.String())
		}
		for _, r := range h.CurrentRelaysToMe {
			hs.RelayedVia = append(hs.RelayedVia, r.String())
		}
		if h.CurrentRemote.IsValid() {
			hs.Remote = h.CurrentRemote.String()
		}
		hosts = append(hosts, hs)
	}
	return map[string]any{"hosts": hosts, "inboundPort": b.inbound.Load()}
}

func (b *bridge) controlHandler() http.Handler {
	mux := http.NewServeMux()
	reply := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(v)
	}
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) { reply(w, b.status()) })
	mux.HandleFunc("POST /inbound", func(w http.ResponseWriter, r *http.Request) {
		port, err := strconv.Atoi(r.URL.Query().Get("port"))
		if err != nil || port < 0 || port > 65535 {
			http.Error(w, "bad port", http.StatusBadRequest)
			return
		}
		b.inbound.Store(int32(port))
		reply(w, map[string]bool{"ok": true})
	})
	// /reload re-reads the configuration file: a new blocklist, relay list or lighthouse list applies without
	// dropping tunnels, and with pki.disconnect_invalid a revoked member is cut off at once.
	mux.HandleFunc("POST /reload", func(w http.ResponseWriter, r *http.Request) {
		b.cfg.ReloadConfig()
		// disconnect_invalid closes a revoked peer's tunnels during the reload; its bridged TCP connections would
		// otherwise hang until a timeout, because nothing inside the dead tunnel can reset them.
		go func() {
			time.Sleep(time.Second)
			if n := b.closeOrphans(); n > 0 {
				b.log.Info("closed bridged connections without a tunnel", "count", n)
			}
		}()
		reply(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /stop", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]bool{"ok": true})
		select {
		case <-b.stop:
		default:
			close(b.stop)
		}
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !b.tokenOK(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
}
