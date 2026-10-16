import { createHash } from 'node:crypto';
import { type LISHOverlayDefinition, type LISHOverlayHost } from '@shared';

/** TCP port of every lishnet node inside its overlay. Each overlay has its own netstack, so one port fits all. */
export const OVERLAY_LIBP2P_PORT = 9090;
/**
 * UDP socket buffers of a lighthouse or relay; with the defaults the OS dropped hundreds of thousands of packets in
 * fast transfers. Members keep the OS defaults: raising them past the system limit needs privileges a member does
 * not have, and their own traffic is one stream at a time.
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
		listen: own ? { host: '0.0.0.0', port: hostPort(own.addr).port, read_buffer: UDP_BUFFER_BYTES, write_buffer: UDP_BUFFER_BYTES } : { host: '0.0.0.0', port: 0 },
		punchy: { punch: !isInfra && overlay.lanDirect, respond: !isInfra && overlay.lanDirect },
		relay: { am_relay: isRelay, use_relays: true, relays: isRelay ? [] : orderRelays(overlay.relays, input.peerID) },
		firewall: {
			outbound: [{ port: 'any', proto: 'any', host: 'any' }],
			inbound: [{ port: OVERLAY_LIBP2P_PORT, proto: 'tcp', host: 'any' }],
		},
		logging: { level: input.logLevel ?? 'info', format: 'json' },
	};
}

/** Every distinct host name of the lishnet's lighthouses and relays. */
export function infraHosts(overlay: LISHOverlayDefinition): string[] {
	return [...new Set([...overlay.lighthouses, ...overlay.relays].map(h => hostPort(h.addr).host))];
}
