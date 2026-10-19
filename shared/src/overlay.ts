// Protected lishnets: a lishnet that lives inside its own Nebula overlay. Members see each other only under
// overlay addresses; their public addresses are known to the network's own lighthouses and relays only.
import { CodedError, ErrorCodes } from './errors.ts';

/** A lighthouse or relay of a protected lishnet. */
export interface LISHOverlayHost {
	/** Address inside the overlay. */
	vpnIP: string;
	/** Public UDP endpoint, `host:port`. */
	addr: string;
	/** libp2p peer ID of the host's own overlay node; such a host is also a bootstrap peer of the lishnet. */
	peerID?: string;
}

/** Overlay part of a protected lishnet definition. Public: it travels in the `.lishnet` file, keys never do. */
export interface LISHOverlayDefinition {
	type: 'nebula';
	/** PEM certificate of the lishnet's certificate authority, held by its founder. */
	caCert: string;
	/** IPv4 subnet of member addresses, e.g. `100.64.0.0/16`. */
	subnet: string;
	lighthouses: LISHOverlayHost[];
	relays: LISHOverlayHost[];
	/** Members behind the same public address connect directly and see each other's LAN address. */
	lanDirect: boolean;
	/** Version of the signed network state these hosts come from; 0 is the definition as created. */
	version: number;
}

/** What a member hands to the founder to ask for access. Public data only: the private key stays with the member. */
export interface OverlayAccessRequest {
	type: 'lish-overlay-request';
	networkID: string;
	/** Human-readable name the member chose. */
	name: string;
	/** libp2p peer ID of the member's node in this lishnet; the certificate is bound to it. */
	peerID: string;
	/** The member's Nebula public key (PEM). */
	publicKey: string;
	/** Public `host:port` this node offers as a lighthouse and relay, if it should be one. */
	infraAddr?: string;
	created: string;
}

/** The founder's answer to a request: the member's certificate and the latest signed network state. */
export interface OverlayCertificateBundle {
	type: 'lish-overlay-certificate';
	networkID: string;
	certificate: string;
	state?: SignedOverlayState;
}

/** The founder's signed rules of a lishnet: its infrastructure and its revoked certificates. */
export interface OverlayState {
	networkID: string;
	/** Strictly increasing; a node keeps the highest version it has verified. */
	version: number;
	lighthouses: LISHOverlayHost[];
	relays: LISHOverlayHost[];
	/** Fingerprints of revoked certificates. */
	revoked: string[];
	/**
	 * Revoked members by peer ID (the certificate name), with the time of the revocation (ISO 8601): every
	 * certificate of that node issued before it is revoked, also one another device holding the CA key issued and
	 * this one never saw. A certificate issued later (an approval after the revocation) is not.
	 */
	revokedPeers?: Record<string, string>;
}

/** How long before a member's certificate ends it may ask for a renewal (the request is the one it makes to join). */
export const MEMBER_RENEWAL_WINDOW_MS: number = 30 * 86_400_000;

/** The revocations a node knows: fingerprints and revoked members ({@link OverlayState.revokedPeers}). */
export interface OverlayRevocations {
	fingerprints: string[];
	peers: Record<string, string>;
}

/** Both sets of revocations together; a member revoked twice keeps the later time. Revocations are never dropped. */
export function mergeRevocations(a: OverlayRevocations, b: OverlayRevocations): OverlayRevocations {
	const peers = { ...a.peers };
	for (const [peerID, at] of Object.entries(b.peers)) if (!peers[peerID] || Date.parse(at) > Date.parse(peers[peerID]!)) peers[peerID] = at;
	return { fingerprints: [...new Set([...a.fingerprints, ...b.fingerprints])], peers };
}

/** Whether a certificate is revoked: by its fingerprint, or as a member's certificate issued before the member was revoked. */
export function isRevoked(revocations: OverlayRevocations, cert: { name: string; fingerprint: string; notBefore: string }): boolean {
	if (revocations.fingerprints.includes(cert.fingerprint)) return true;
	const at = revocations.peers[cert.name];
	return at !== undefined && Date.parse(cert.notBefore) < Date.parse(at);
}

/** An {@link OverlayState} as JSON with an ed25519 signature (hex) by the lishnet's CA key. */
export interface SignedOverlayState {
	state: string;
	signature: string;
}

/** A request waiting for the founder's decision. */
export interface OverlayPendingRequest extends OverlayAccessRequest {
	id: string;
	received: string;
}

/** A certificate the founder issued. */
export interface OverlayMember {
	name: string;
	/** The founder's own node: the lishnet's authority, which cannot be revoked. */
	founder?: boolean;
	peerID: string;
	vpnIP: string;
	roles: OverlayRole[];
	notAfter: string;
	fingerprint: string;
	issued: string;
	revoked: boolean;
}

/** Infrastructure roles a member certificate can carry. */
export type OverlayRole = 'lighthouse' | 'relay';

export interface OverlayHostStatus extends LISHOverlayHost {
	role: OverlayRole;
	/** A tunnel to the host exists right now (always true for {@link self}). */
	connected: boolean;
	/** This node is that host. */
	self?: boolean;
}

export interface OverlayPeerStatus {
	vpnIP: string;
	name: string;
	/** `relay` when traffic goes through one of the lishnet's relays, `direct` for a LAN neighbour or a host. */
	path: 'direct' | 'relay';
}

export interface OverlayStatus {
	networkID: string;
	/** `founder` holds the CA key; `member` has a certificate; `none` has neither yet. */
	role: 'founder' | 'member' | 'none';
	certificate?: { name: string; vpnIP: string; groups: string[]; notBefore: string; notAfter: string; fingerprint: string; revoked: boolean };
	/** A request was created and no certificate has been imported yet. */
	request?: OverlayAccessRequest;
	running: boolean;
	stateVersion: number;
	hosts: OverlayHostStatus[];
	peers: OverlayPeerStatus[];
}

const MAX_HOSTS = 32;
const PEER_ID = /^[1-9A-HJ-NP-Za-km-z]{40,64}$/;

function invalid(detail: string): CodedError {
	return new CodedError(ErrorCodes.NETWORK_INVALID, detail);
}

function ipv4ToInt(ip: string): number | null {
	const parts = ip.split('.');
	if (parts.length !== 4) return null;
	let n = 0;
	for (const p of parts) {
		if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
		n = n * 256 + Number(p);
	}
	return n;
}

/** Parse `a.b.c.d/n` into its network base and size; null when malformed or not aligned to its prefix. */
export function parseSubnet(cidr: string): { base: number; bits: number; size: number } | null {
	const [ip, prefix] = cidr.split('/');
	const base = ipv4ToInt(ip ?? '');
	const bits = Number(prefix);
	if (base === null || !Number.isInteger(bits) || bits < 8 || bits > 30) return null;
	const size = 2 ** (32 - bits);
	if (base % size !== 0) return null;
	return { base, bits, size };
}

export function ipInSubnet(ip: string, cidr: string): boolean {
	const s = parseSubnet(cidr);
	const n = ipv4ToInt(ip);
	return s !== null && n !== null && n >= s.base && n < s.base + s.size;
}

/** The `index`-th address of a subnet (1 = first usable). */
export function subnetAddress(cidr: string, index: number): string {
	const s = parseSubnet(cidr);
	if (!s || index < 1 || index >= s.size - 1) throw invalid(`no address ${index} in ${cidr}`);
	const n = s.base + index;
	return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** Validate `host:port` of a public UDP endpoint (IPv4 address or DNS name). */
export function isHostPort(addr: unknown): addr is string {
	if (typeof addr !== 'string' || addr.length > 260) return false;
	const sep = addr.lastIndexOf(':');
	if (sep <= 0) return false;
	const host = addr.slice(0, sep);
	const port = Number(addr.slice(sep + 1));
	if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
	return ipv4ToInt(host) !== null || /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host);
}

/** Validate an untrusted list of lighthouses or relays of a lishnet with this subnet. Throws NETWORK_INVALID. */
export function validateOverlayHosts(value: unknown, subnet: string, what: string): LISHOverlayHost[] {
	if (!Array.isArray(value)) throw invalid(`${what} must be a list`);
	if (value.length > MAX_HOSTS) throw invalid(`at most ${MAX_HOSTS} ${what}`);
	return value.map(h => {
		if (typeof h !== 'object' || h === null) throw invalid(`malformed ${what} entry`);
		const { vpnIP, addr, peerID } = h as Record<string, unknown>;
		if (typeof vpnIP !== 'string' || !ipInSubnet(vpnIP, subnet)) throw invalid(`${what}: ${String(vpnIP)} is not in ${subnet}`);
		if (!isHostPort(addr)) throw invalid(`${what}: ${String(addr)} is not host:port`);
		if (peerID !== undefined && (typeof peerID !== 'string' || !PEER_ID.test(peerID))) throw invalid(`${what}: malformed peer ID`);
		return { vpnIP, addr, ...(peerID !== undefined ? { peerID: peerID as string } : {}) };
	});
}

/** Validate an untrusted overlay definition (from a `.lishnet` file or the API). Throws NETWORK_INVALID. */
export function validateOverlayDefinition(value: unknown): LISHOverlayDefinition {
	if (typeof value !== 'object' || value === null) throw invalid('overlay must be an object');
	const o = value as Record<string, unknown>;
	if (o['type'] !== 'nebula') throw invalid('unsupported overlay type');
	const caCert = o['caCert'];
	if (typeof caCert !== 'string' || caCert.length > 8192 || !caCert.trimStart().startsWith('-----BEGIN NEBULA CERTIFICATE')) throw invalid('overlay CA certificate is missing or malformed');
	const subnet = o['subnet'];
	if (typeof subnet !== 'string' || !parseSubnet(subnet)) throw invalid('overlay subnet must be an aligned IPv4 subnet between /8 and /30');
	const version = o['version'] ?? 0;
	if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) throw invalid('overlay version must be a non-negative integer');
	const lanDirect = o['lanDirect'] ?? false;
	if (typeof lanDirect !== 'boolean') throw invalid('overlay lanDirect must be a boolean');
	return { type: 'nebula', caCert, subnet, lighthouses: validateOverlayHosts(o['lighthouses'] ?? [], subnet, 'lighthouses'), relays: validateOverlayHosts(o['relays'] ?? [], subnet, 'relays'), lanDirect, version };
}

/** Validate an untrusted access request. Throws NETWORK_INVALID. */
export function validateAccessRequest(value: unknown): OverlayAccessRequest {
	if (typeof value !== 'object' || value === null) throw invalid('request must be an object');
	const r = value as Record<string, unknown>;
	if (r['type'] !== 'lish-overlay-request') throw invalid('not an access request');
	const { networkID, name, peerID, publicKey, infraAddr, created } = r;
	if (typeof networkID !== 'string' || networkID.length === 0 || networkID.length > 128) throw invalid('request without a network ID');
	if (typeof name !== 'string' || name.trim().length === 0 || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) throw invalid('request name must be 1-64 printable characters');
	if (typeof peerID !== 'string' || !PEER_ID.test(peerID)) throw invalid('request with a malformed peer ID');
	if (typeof publicKey !== 'string' || publicKey.length > 1024 || !publicKey.trimStart().startsWith('-----BEGIN NEBULA X25519 PUBLIC KEY')) throw invalid('request with a malformed public key');
	if (infraAddr !== undefined && !isHostPort(infraAddr)) throw invalid('request infrastructure address must be host:port');
	if (typeof created !== 'string' || Number.isNaN(Date.parse(created))) throw invalid('request without a creation time');
	return { type: 'lish-overlay-request', networkID, name: name.trim(), peerID, publicKey, ...(infraAddr !== undefined ? { infraAddr: infraAddr as string } : {}), created };
}
