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
	/** Limits on members' older certificates ({@link OverlayRevocations.limits}). */
	limits?: Record<string, OverlayLimit[]>;
}

/**
 * One approval's limit on a member's other certificates: `[before, until]`, the start and end of the certificate it
 * issued, and on newer ones the device holding the CA key that issued it and what that device knew: per other device,
 * the start of that device's newest approval of the member ({@link limitCaps}).
 */
export type OverlayLimit = [string, string] | [string, string, string, Record<string, string>];

/** A signed state carries at most this many limits per member; {@link compactRevocations} keeps to it. */
export const MAX_LIMITS_PER_MEMBER = 64;
const DEVICE_ID = /^[0-9a-f]{8}$/;
const MAX_DEVICES = 64;

/** Whether an untrusted value is an {@link OverlayLimit}. */
export function isOverlayLimit(value: unknown): value is OverlayLimit {
	const time = (t: unknown): boolean => typeof t === 'string' && t.length <= 40 && !Number.isNaN(Date.parse(t));
	if (!Array.isArray(value) || !time(value[0]) || !time(value[1])) return false;
	if (value.length === 2) return true;
	const seen = value[3];
	return value.length === 4 && typeof value[2] === 'string' && DEVICE_ID.test(value[2]) && typeof seen === 'object' && seen !== null && !Array.isArray(seen) && Object.keys(seen).length <= MAX_DEVICES && Object.entries(seen).every(([device, at]) => DEVICE_ID.test(device) && time(at));
}

/** How long before a member's certificate ends it may ask for a renewal (the request is the one it makes to join). */
export const MEMBER_RENEWAL_WINDOW_MS: number = 30 * 86_400_000;

/** The revocations a node knows: fingerprints and revoked members ({@link OverlayState.revokedPeers}). */
export interface OverlayRevocations {
	fingerprints: string[];
	peers: Record<string, string>;
	/**
	 * Per member (peer ID), one {@link OverlayLimit} per approval: the newest decision on how long a member stays bounds
	 * every older certificate — also a longer one another device holding the CA key issued and this one never saw —
	 * from its own end on, without cutting the member off before that.
	 */
	limits?: Record<string, OverlayLimit[]>;
}

const sameLimit = (x: OverlayLimit, y: OverlayLimit): boolean => JSON.stringify(x) === JSON.stringify(y);

/**
 * Whether the approval behind `l` knew of the one behind `e`. One device orders its own approvals by their start (each
 * starts after every one it knows); across devices only what `l`'s device had seen counts — their clocks may differ.
 */
function knows(l: OverlayLimit, e: OverlayLimit): boolean {
	if (l[2] === undefined || e[2] === undefined || l[2] === e[2]) return Date.parse(e[0]) < Date.parse(l[0]);
	const seen = l[3]?.[e[2]];
	return seen !== undefined && Date.parse(e[0]) <= Date.parse(seen);
}

/**
 * Whether limit `l` ends the certificate of approval `e` at `l`'s end: a decision made knowing of `e` does, and of two
 * decisions neither knew of (two devices holding the CA key, each unaware of the other's) the shorter one wins.
 */
export function limitCaps(l: OverlayLimit, e: OverlayLimit): boolean {
	return knows(l, e) || (!knows(e, l) && Date.parse(l[1]) < Date.parse(e[1]));
}

/** Both sets of revocations together; a member revoked twice keeps the later time. Revocations are never dropped. */
export function mergeRevocations(a: OverlayRevocations, b: OverlayRevocations): OverlayRevocations {
	const peers = { ...a.peers };
	for (const [peerID, at] of Object.entries(b.peers)) if (!peers[peerID] || Date.parse(at) > Date.parse(peers[peerID]!)) peers[peerID] = at;
	const limits: Record<string, OverlayLimit[]> = {};
	for (const source of [a.limits, b.limits])
		for (const [peerID, list] of Object.entries(source ?? {})) {
			const held = (limits[peerID] ??= []);
			for (const limit of list) if (!held.some(l => sameLimit(l, limit))) held.push(limit);
		}
	return { fingerprints: [...new Set([...a.fingerprints, ...b.fingerprints])], peers, ...(Object.keys(limits).length > 0 ? { limits } : {}) };
}

/**
 * Two limits as one, when a member has more than {@link MAX_LIMITS_PER_MEMBER}: the older one's certificate then counts
 * by its start alone, and the newer one ends what either ended, at the earlier of their ends.
 *
 * shortcut: the newer certificate then also counts as ending at that earlier end when it is weighed against a decision of
 * another device that knew of neither, so it may outlast a shorter such decision; only past 64 approvals of one member
 * still in force, signed by two devices unaware of each other.
 */
function mergeLimits(older: OverlayLimit, newer: OverlayLimit): OverlayLimit {
	const until = Date.parse(older[1]) < Date.parse(newer[1]) ? older[1] : newer[1];
	if (newer[2] === undefined) return [newer[0], until];
	const seen = { ...newer[3] };
	for (const [device, at] of [...Object.entries(older[3] ?? {}), ...(older[2] !== undefined && older[2] !== newer[2] ? [[older[2], older[0]] as const] : [])]) if (!seen[device] || Date.parse(at) > Date.parse(seen[device]!)) seen[device] = at;
	return [newer[0], until, newer[2], seen];
}

/**
 * The same revocations in their smallest form at `now`: a limit whose `until` has passed revokes, from now on, every
 * certificate valid from before its `before` — a revocation of the member at that time — unless it also ends a newer
 * certificate (of a device that did not know of it), and a limit that ends nothing not revoked already goes. Past
 * {@link MAX_LIMITS_PER_MEMBER} the oldest ones are merged ({@link mergeLimits}). States signed with it stay small and
 * valid; it holds the same for any later time.
 */
export function compactRevocations(r: OverlayRevocations, now: number = Date.now()): OverlayRevocations {
	const peers = { ...r.peers };
	const after = (t: string, peerID: string): boolean => !peers[peerID] || Date.parse(t) > Date.parse(peers[peerID]!);
	/** Certificates still in force `l` ends that its start alone does not cover: of approvals that did not know of it. */
	const newerCapped = (l: OverlayLimit, list: OverlayLimit[], peerID: string): boolean => list.some(e => e !== l && Date.parse(e[1]) > now && Date.parse(e[0]) >= Date.parse(l[0]) && after(e[0], peerID) && limitCaps(l, e));
	for (const [peerID, list] of Object.entries(r.limits ?? {})) for (const l of list) if (Date.parse(l[1]) <= now && !newerCapped(l, list, peerID) && after(l[0], peerID)) peers[peerID] = l[0];
	const limits: Record<string, OverlayLimit[]> = {};
	for (const [peerID, list] of Object.entries(r.limits ?? {})) {
		const kept = list.filter(l => (Date.parse(l[1]) > now && after(l[0], peerID)) || newerCapped(l, list, peerID)).sort((x, y) => Date.parse(x[0]) - Date.parse(y[0]) || JSON.stringify(x).localeCompare(JSON.stringify(y)));
		while (kept.length > MAX_LIMITS_PER_MEMBER) kept.splice(0, 2, mergeLimits(kept[0]!, kept[1]!));
		if (kept.length > 0) limits[peerID] = kept;
	}
	// Sorted throughout, so two equal sets compare equal as JSON.
	const sorted = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).sort(([x], [y]) => x.localeCompare(y)));
	return { fingerprints: [...new Set(r.fingerprints)].sort(), peers: sorted(peers), ...(Object.keys(limits).length > 0 ? { limits: sorted(limits) } : {}) };
}

/** The earliest end of a limit still ahead of `now`: when a certificate in use may next become revoked. */
export function nextLimitEnd(r: OverlayRevocations, now: number = Date.now()): number | null {
	const ends = Object.values(r.limits ?? {}).flatMap(list => list.map(l => Date.parse(l[1])).filter(t => t > now));
	return ends.length > 0 ? Math.min(...ends) : null;
}

/**
 * Whether a certificate is revoked: by its fingerprint, as a member's certificate issued before the member was
 * revoked, or as one a limit of another approval ends ({@link limitCaps}) at an end that has passed. A certificate
 * whose own approval no limit records anymore counts by its start: ended by every approval that started later.
 */
export function isRevoked(revocations: OverlayRevocations, cert: { name: string; fingerprint: string; notBefore: string }, now: number = Date.now()): boolean {
	if (revocations.fingerprints.includes(cert.fingerprint)) return true;
	const from = Date.parse(cert.notBefore);
	const at = revocations.peers[cert.name];
	if (at !== undefined && from < Date.parse(at)) return true;
	const list = revocations.limits?.[cert.name] ?? [];
	const own = list.find(l => Date.parse(l[0]) === from);
	return list.some(l => l !== own && now >= Date.parse(l[1]) && (own ? limitCaps(l, own) : from < Date.parse(l[0])));
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
	/** The invite it came through; its certificate then goes back the same way. */
	invite?: string;
	/** A member's renewal, handed in over the lishnet itself; its certificate goes back the same way. */
	renewal?: boolean;
}

/**
 * The founder's invitation to a protected lishnet. Its guest certificate (group `guest`, short-lived) lets the
 * invited node reach the founder inside the overlay and nothing else: every node's firewall admits members only,
 * the founder's also guests, and the founder's node answers a guest with the invite exchange alone. Over it the
 * node hands in its access request and later picks up its certificate. A secret: whoever holds it can ask for
 * access in its name until it expires or is used.
 */
export interface OverlayInvite {
	type: 'lish-overlay-invite';
	id: string;
	/** The lishnet definition, as in a `.lishnet` file. */
	network: { networkID: string; name: string; description: string; bootstrapPeers: string[]; overlay: LISHOverlayDefinition };
	/** Overlay address of the founder's device that made the invite. */
	founder: string;
	/** The guest certificate and its private key (PEM). */
	cert: string;
	key: string;
	expires: string;
}

/** How far an invited node got: the founder not reached yet, the request handed in, or the end of the invite. */
export type OverlayInviteState = 'delivering' | 'pending' | 'refused' | 'expired';

/** One message of the invite exchange, guest to founder, and the answer. */
export interface OverlayInviteMessage {
	invite: string;
	request: OverlayAccessRequest;
}
export type OverlayInviteAnswer = { status: 'pending' } | { status: 'approved'; bundle: OverlayCertificateBundle } | { status: 'refused'; reason: string };

const INVITE_PREFIX = 'lishinvite:';

/** The invite as one line of text to pass on. */
export function encodeInvite(invite: OverlayInvite): string {
	return INVITE_PREFIX + btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(invite))));
}

/** Read an invite (text from {@link encodeInvite}, or its JSON) and validate its shape. Throws NETWORK_INVALID. */
export function decodeInvite(text: string): OverlayInvite {
	const trimmed = text.trim();
	let raw: any;
	try {
		raw = JSON.parse(trimmed.startsWith(INVITE_PREFIX) ? new TextDecoder().decode(Uint8Array.from(atob(trimmed.slice(INVITE_PREFIX.length).replace(/\s+/g, '')), c => c.charCodeAt(0))) : trimmed);
	} catch {
		throw invalid('not an invite');
	}
	if (raw?.type !== 'lish-overlay-invite') throw invalid('not an invite');
	const { id, network, founder, cert, key, expires } = raw;
	if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw invalid('invite without an ID');
	if (typeof network !== 'object' || network === null || typeof network.networkID !== 'string' || typeof network.name !== 'string') throw invalid('invite without a lishnet');
	const overlay = validateOverlayDefinition(network.overlay);
	if (typeof founder !== 'string' || !ipInSubnet(founder, overlay.subnet)) throw invalid('invite founder address is not in the lishnet');
	if (typeof cert !== 'string' || cert.length > 8192 || !cert.trimStart().startsWith('-----BEGIN NEBULA CERTIFICATE')) throw invalid('invite certificate is malformed');
	if (typeof key !== 'string' || key.length > 1024 || !key.trimStart().startsWith('-----BEGIN NEBULA X25519 PRIVATE KEY')) throw invalid('invite key is malformed');
	if (typeof expires !== 'string' || Number.isNaN(Date.parse(expires))) throw invalid('invite without an expiry');
	const bootstrapPeers = Array.isArray(network.bootstrapPeers) ? network.bootstrapPeers.filter((p: unknown) => typeof p === 'string') : [];
	return { type: 'lish-overlay-invite', id, network: { networkID: network.networkID, name: network.name, description: typeof network.description === 'string' ? network.description : '', bootstrapPeers, overlay }, founder, cert, key, expires };
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
	/** The request goes through an invite: where its delivery stands. */
	invite?: { expires: string; state: OverlayInviteState };
	/** The founder refused the renewal {@link request}; a new request can be made. */
	renewalRefused?: boolean;
	/** What the last answered request asked as, to fill in a renewal. */
	lastRequest?: { name: string; infraAddr?: string };
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
