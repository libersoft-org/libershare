package main

// The netstack wiring follows github.com/slackhq/nebula/service (MIT). It is kept here rather than used
// through service.New because that package fixes the TCP buffer sizes, and with gVisor's defaults (about
// 64 KB windows) one stream stalls at window/RTT, measured at about 3 MB/s across a relay.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"time"

	"github.com/slackhq/nebula"
	"github.com/slackhq/nebula/overlay"
	"golang.org/x/sync/errgroup"
	"gvisor.dev/gvisor/pkg/buffer"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/link/channel"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
	"gvisor.dev/gvisor/pkg/waiter"
)

const (
	nicID = 1
	// tcpBufferMax lets auto-tuning grow a stream's window to 8 MB.
	tcpBufferMax = 8 << 20

	keepaliveIdle     = 10 * time.Second
	keepaliveInterval = 5 * time.Second
	keepaliveCount    = 3
	// userTimeout: data unacknowledged this long means the peer is gone (measured worst case on the fleet's
	// slowest relay path stays far below it).
	userTimeout = 20 * time.Second
)

// failFast makes a dead connection fail fast instead of staying open until the backend's own idle timeout (46 s
// measured, while libp2p kept using it): a busy connection gives up after 20 s of unacknowledged data, an idle one
// after keepalive probes go unanswered (25 s), and a peer that restarted answers the first segment with a reset.
func failFast(ep tcpip.Endpoint) {
	ep.SocketOptions().SetKeepAlive(true)
	idle := tcpip.KeepaliveIdleOption(keepaliveIdle)
	interval := tcpip.KeepaliveIntervalOption(keepaliveInterval)
	timeout := tcpip.TCPUserTimeoutOption(userTimeout)
	ep.SetSockOpt(&idle)
	ep.SetSockOpt(&interval)
	ep.SetSockOpt(&timeout)
	ep.SetSockOptInt(tcpip.KeepaliveCountOption, keepaliveCount)
}

// netstack is a TCP/IP stack on top of a Nebula user device, accepting inbound TCP on one port only.
type netstack struct {
	stack *stack.Stack
	eg    *errgroup.Group
}

// newNetstack starts Nebula and attaches the stack to it. onAccept runs in its own goroutine for every
// inbound connection to port.
func newNetstack(control *nebula.Control, port uint16, onAccept func(net.Conn)) (_ *netstack, reterr error) {
	device, ok := control.Device().(*overlay.UserDevice)
	if !ok {
		return nil, errors.New("nebula is not using the user device")
	}
	if err := control.Start(); err != nil {
		return nil, err
	}
	defer func() {
		if reterr != nil {
			control.Stop()
		}
	}()
	ctx := control.Context()
	eg, ctx := errgroup.WithContext(ctx)
	s := stack.New(stack.Options{
		NetworkProtocols:   []stack.NetworkProtocolFactory{ipv4.NewProtocol},
		TransportProtocols: []stack.TransportProtocolFactory{tcp.NewProtocol},
	})
	sack := tcpip.TCPSACKEnabled(true)
	rcv := tcpip.TCPReceiveBufferSizeRangeOption{Min: 4096, Default: 1 << 20, Max: tcpBufferMax}
	snd := tcpip.TCPSendBufferSizeRangeOption{Min: 4096, Default: 1 << 20, Max: tcpBufferMax}
	moderate := tcpip.TCPModerateReceiveBufferOption(true)
	// RACK loss detection walks every unacknowledged segment on each ACK; with an 8 MB window it took over half of
	// the sender's CPU and capped a stream at 6–10 MiB/s. Plain SACK recovery: 24 MiB/s on the same hosts.
	recovery := tcpip.TCPRecovery(0)
	for _, opt := range []tcpip.SettableTransportProtocolOption{&sack, &rcv, &snd, &moderate, &recovery} {
		if err := s.SetTransportProtocolOption(tcp.ProtocolNumber, opt); err != nil {
			return nil, fmt.Errorf("netstack TCP option: %v", err)
		}
	}
	// A full queue drops the packet silently, so it holds a whole 8 MB send window: with 512 a stream lost 6–8 % of
	// its segments to its own bursts.
	linkEP := channel.New(8192, 1280, "")
	if err := s.CreateNIC(nicID, linkEP); err != nil {
		return nil, fmt.Errorf("netstack NIC: %v", err)
	}
	any4, _ := tcpip.NewSubnet(tcpip.AddrFrom4([4]byte{}), tcpip.MaskFrom("\x00\x00\x00\x00"))
	s.SetRouteTable([]tcpip.Route{{Destination: any4, NIC: nicID}})
	networks := device.Networks()
	if len(networks) == 0 || !networks[0].Addr().Is4() {
		return nil, errors.New("the certificate has no IPv4 address")
	}
	pa := tcpip.ProtocolAddress{AddressWithPrefix: tcpip.AddrFromSlice(networks[0].Addr().AsSlice()).WithPrefix(), Protocol: ipv4.ProtocolNumber}
	if err := s.AddProtocolAddress(nicID, pa, stack.AddressProperties{}); err != nil {
		return nil, fmt.Errorf("netstack address: %v", err)
	}
	fwd := tcp.NewForwarder(s, 0, 1024, func(r *tcp.ForwarderRequest) {
		if r.ID().LocalPort != port {
			r.Complete(true)
			return
		}
		var wq waiter.Queue
		ep, err := r.CreateEndpoint(&wq)
		if err != nil {
			r.Complete(true)
			return
		}
		r.Complete(false)
		failFast(ep)
		go onAccept(gonet.NewTCPConn(&wq, ep))
	})
	s.SetTransportProtocolHandler(tcp.ProtocolNumber, fwd.HandlePacket)

	reader, writer := device.Pipe()
	go func() {
		<-ctx.Done()
		reader.Close()
		writer.Close()
	}()
	eg.Go(func() error {
		buf := make([]byte, header.IPv4MaximumHeaderSize+header.IPv4MaximumPayloadSize)
		for {
			n, err := reader.Read(buf)
			if err != nil {
				return err
			}
			pkt := stack.NewPacketBuffer(stack.PacketBufferOptions{Payload: buffer.MakeWithData(bytes.Clone(buf[:n]))})
			linkEP.InjectInbound(header.IPv4ProtocolNumber, pkt)
			pkt.DecRef()
			if err := ctx.Err(); err != nil {
				return err
			}
		}
	})
	eg.Go(func() error {
		for {
			pkt := linkEP.ReadContext(ctx)
			if pkt == nil {
				if err := ctx.Err(); err != nil {
					return err
				}
				continue
			}
			view := pkt.ToView()
			_, err := view.WriteTo(writer)
			view.Release()
			pkt.DecRef()
			if err != nil {
				return err
			}
		}
	})
	eg.Go(control.Wait)
	return &netstack{stack: s, eg: eg}, nil
}

// dial opens a TCP connection to an address inside the overlay. It is gonet.DialContextTCP with keepalive set on
// the endpoint before it connects.
func (n *netstack) dial(ctx context.Context, to netip.AddrPort) (net.Conn, error) {
	if !to.Addr().Is4() {
		return nil, errors.New("only IPv4 overlay addresses are supported")
	}
	full := tcpip.FullAddress{NIC: nicID, Addr: tcpip.AddrFromSlice(to.Addr().AsSlice()), Port: to.Port()}
	var wq waiter.Queue
	ep, terr := n.stack.NewEndpoint(tcp.ProtocolNumber, ipv4.ProtocolNumber, &wq)
	if terr != nil {
		return nil, errors.New(terr.String())
	}
	failFast(ep)
	entry, notify := waiter.NewChannelEntry(waiter.WritableEvents)
	wq.EventRegister(&entry)
	defer wq.EventUnregister(&entry)
	terr = ep.Connect(full)
	if _, started := terr.(*tcpip.ErrConnectStarted); started {
		select {
		case <-ctx.Done():
			ep.Close()
			return nil, ctx.Err()
		case <-notify:
		}
		terr = ep.LastError()
	}
	if terr != nil {
		ep.Close()
		return nil, fmt.Errorf("connect %s: %s", to, terr)
	}
	return gonet.NewTCPConn(&wq, ep), nil
}
