import { createHash } from 'node:crypto';
import { type LISHOverlayDefinition, type LISHOverlayHost } from '@shared';

/** TCP port of every lishnet node inside its overlay. Each overlay has its own netstack, so one port fits all. */
export const OVERLAY_LIBP2P_PORT = 9090;
/**
 * UDP socket buffers of every node. With the OS defaults a relay dropped hundreds of thousands of packets in fast
 * transfers, and a receiving member tens of thousands (measured: one 256 MiB download through a relay stalled for
 * 20 s while TCP recovered). Where raising them needs privileges the node lacks (Linux without root), Nebula logs
 * the failure and keeps the defaults.
 */
const UDP_BUFFER_BYTES = 32 * 1024 * 1024;
/** Underlay ranges a LAN neighbour can be reached on when the lishnet allows direct LAN connections. */
const PRIVATE_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

export interface NebulaConfigInput {
	/** Paths of the CA certificate, this node's certificate and its private key. */
	pki: { ca: string; cert: string; key: string };
	overlay: LISHOverlayDefinition;
	/** This node's overlay address. */
	vpnIP: string;
	/** This node's libp2p peer ID; it decides the order of its relays. */
	peerID: string;
	/** Fingerprints of revoked certificates. */
	revoked: string[];
	/** Underlay IPv4 addresses of the lishnet's lighthouses and relays (their `addr` hosts, resolved). */
	infraIPs: string[];
	logLevel?: 'debug' | 'info' | 'warning' | 'error';
}

function hostPort(addr: string): { host: string; port: number } {
	const sep = addr.lastIndexOf(':');
	return { host: addr.slice(0, sep), port: Number(addr.slice(sep + 1)) };
}

/**
 * The relays other members should reach this node through, in an order unique to this node. Nebula uses the
 * target's list, so spreading the first choice over the relays by peer ID spreads the members over them; the rest
 * of the list stays as fallback.
 */
export function orderRelays(relays: LISHOverlayHost[], peerID: string): string[] {
	const rank = (r: LISHOverlayHost): string =>
		createHash('sha256')
			.update(peerID + '|' + r.vpnIP)
			.digest('hex');
	return [...relays].sort((a, b) => rank(a).localeCompare(rank(b))).map(r => r.vpnIP);
}

/**
 * Nebula configuration of one lishnet node (JSON, which Nebula's YAML loader reads as well).
 *
 * A member may exchange packets with the lishnet's infrastructure only (plus LAN neighbours when `lanDirect`):
 * `remote_allow_list` drops every other underlay address, so a member never sends a packet to another member's
 * public address even if somebody hands it one. The lighthouses answer queries with relays only
 * (`hide_addresses`, our Nebula patch), so a member's public address is known to the infrastructure alone.
 */
export function buildNebulaConfig(input: NebulaConfigInput): Record<string, unknown> {
	const { overlay, vpnIP } = input;
	const isLighthouse = overlay.lighthouses.some(h => h.vpnIP === vpnIP);
	const isRelay = overlay.relays.some(h => h.vpnIP === vpnIP);
	const own = [...overlay.lighthouses, ...overlay.relays].find(h => h.vpnIP === vpnIP);
	const isInfra = own !== undefined;
	const staticHostMap: Record<string, string[]> = {};
	for (const h of [...overlay.lighthouses, ...overlay.relays]) {
		if (h.vpnIP === vpnIP) continue;
		const list = (staticHostMap[h.vpnIP] ??= []);
		if (!list.includes(h.addr)) list.push(h.addr);
	}
	const lighthouse: Record<string, unknown> = {
		am_lighthouse: isLighthouse,
		hosts: isLighthouse ? [] : overlay.lighthouses.filter(h => h.vpnIP !== vpnIP).map(h => h.vpnIP),
		interval: 30,
		hide_addresses: true,
	};
	if (!isInfra) {
		const remote: Record<string, boolean> = { '0.0.0.0/0': false, '::/0': false };
		for (const ip of input.infraIPs) remote[`${ip}/32`] = true;
		if (overlay.lanDirect) for (const range of PRIVATE_RANGES) remote[range] = true;
		lighthouse['remote_allow_list'] = remote;
		const local: Record<string, boolean> = { '0.0.0.0/0': false, '::/0': false };
		if (overlay.lanDirect) for (const range of PRIVATE_RANGES) local[range] = true;
		lighthouse['local_allow_list'] = local;
	}
	return {
		pki: { ca: input.pki.ca, cert: input.pki.cert, key: input.pki.key, blocklist: input.revoked, disconnect_invalid: true },
		static_host_map: staticHostMap,
		lighthouse,
		listen: { host: '0.0.0.0', port: own ? hostPort(own.addr).port : 0, read_buffer: UDP_BUFFER_BYTES, write_buffer: UDP_BUFFER_BYTES },
		punchy: { punch: !isInfra && overlay.lanDirect, respond: !isInfra && overlay.lanDirect },
		// A tunnel whose traffic stopped is tested after 2 s and dropped 4 s later (defaults 5 + 10): a member then
		// moves to the next relay in about 6 s when one goes down, instead of about 20 s (measured on the fleet).
		timers: { connection_alive_interval: 2, pending_deletion_interval: 4 },
		relay: { am_relay: isRelay, use_relays: true, relays: isRelay ? [] : orderRelays(overlay.relays, input.peerID) },
		firewall: {
			outbound: [{ port: 'any', proto: 'any', host: 'any' }],
			inbound: [{ port: OVERLAY_LIBP2P_PORT, proto: 'tcp', host: 'any' }],
		},
		logging: { level: input.logLevel ?? 'info', format: 'json' },
	};
}

/**
 * The settings Nebula takes at start only and keeps through a reload: whether this node is a lighthouse and the UDP
 * port it listens on. A change of either needs a restart of the helper.
 */
export function startOnlySettings(overlay: LISHOverlayDefinition, vpnIP: string): string {
	const own = [...overlay.lighthouses, ...overlay.relays].find(h => h.vpnIP === vpnIP);
	return `${overlay.lighthouses.some(h => h.vpnIP === vpnIP)}|${own ? hostPort(own.addr).port : 0}`;
}

/** Every distinct host name of the lishnet's lighthouses and relays. */
export function infraHosts(overlay: LISHOverlayDefinition): string[] {
	return [...new Set([...overlay.lighthouses, ...overlay.relays].map(h => hostPort(h.addr).host))];
}
