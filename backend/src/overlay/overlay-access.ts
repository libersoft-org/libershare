import { Mutex } from 'async-mutex';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { join } from 'node:path';
import { generateKeyPair, generateKeyPairFromSeed, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { type Socket } from 'node:net';
import { CodedError, decodeInvite, encodeInvite, ErrorCodes, ipInSubnet, isHostPort, isOverlayLimit, isRevoked, MEMBER_RENEWAL_WINDOW_MS, mergeRevocations, parseSubnet, subnetAddress, validateAccessRequest, validateOverlayHosts, type LISHNetworkConfig, type LISHOverlayDefinition, type LISHOverlayHost, type OverlayAccessRequest, type OverlayCertificateBundle, type OverlayInviteAnswer, type OverlayInviteState, type OverlayMember, type OverlayPendingRequest, type OverlayRevocations, type OverlayRole, type OverlayStatus } from '@shared';
import { SqliteDatastore } from '../protocol/datastore.ts';
import { PRIVATE_KEY_PATH, writeIdentityKey } from '../protocol/identity-store.ts';
import { runOverlayCommand, type CertificateInfo } from './overlay-binary.ts';
import { GUEST_GROUP, GUEST_NAME_PREFIX, OVERLAY_LIBP2P_PORT } from './nebula-config.ts';
import { type OverlayHelper } from './overlay-helper.ts';
import { answerGuest, askFounder } from './overlay-invite.ts';
import { type OverlayNodes } from './overlay-nodes.ts';
import { signAnswer, verifyAnswer } from './overlay-state.ts';
import { type FounderData, type InviteFile, type OverlayStore, type RenewalDecision, type RenewalRefusal } from './overlay-store.ts';

const DEFAULT_SUBNET = '100.64.0.0/16';
const DEFAULT_MEMBER_DAYS = 365;
/** A founder's own certificate is renewed this long before it ends ({@link OverlayAccess.ensureOwnMembership}). */
export const OWN_RENEWAL_MS: number = 7 * 86_400_000;
const MAX_PENDING_REQUESTS = 1000;
const ROLES: readonly OverlayRole[] = ['lighthouse', 'relay'];
const FINGERPRINT = /^[0-9a-f]{64}$/;
const MEMBERS_BEGIN = '-----BEGIN LISH OVERLAY MEMBERS-----';
const MEMBERS_END = '-----END LISH OVERLAY MEMBERS-----';

/** Addresses of one device's lane ({@link FounderData.lane}); a subnet smaller than two lanes has none. */
const LANE_SIZE = 256;
const DEFAULT_INVITE_DAYS = 7;
const MAX_INVITE_DAYS = 30;
/** How long the founder keeps sending a certificate issued on a renewal ({@link OverlayAccess.repeatAccess}). */
const RENEWAL_DELIVERY_MS = 7 * 86_400_000;
/** An invited node asks the founder again this often, while it waits for the tunnel and then for the approval. */
const INVITE_RETRY_MS = 15_000;

/** The last lane holds invites' guest addresses; a subnet with fewer than three lanes (smaller than /22) has none. */
function guestLane(size: number): number | null {
	const lanes = Math.floor(size / LANE_SIZE);
	return lanes >= 3 ? lanes - 1 : null;
}

function hashOf(text: string): number {
	return createHash('sha256').update(text).digest().readUInt32BE(0);
}

/**
 * A free member address: the first one not in `used`, starting at a slot the peer ID's hash picks, inside the lanes of
 * the device that approves. Two devices holding the CA key do not see what the other handed out; their own lanes keep
 * them apart (counting up from .2, both gave their next new member the same address every time). A subnet too small
 * for lanes uses the whole subnet. Null when the device's lanes are full: it never reaches into another device's lane
 * (falling back to the whole subnet handed out addresses another device had given already).
 *
 * shortcut: a subnet smaller than two lanes (/24 and smaller) has no lanes, so two devices holding the CA key there can
 * give two members one address; and so can two devices restored from one and the same backup, or from two plain ones
 * (they hand over the same lanes, {@link OverlayAccess.exportCA}).
 */
function freeAddress(cidr: string, size: number, peerID: string, used: Set<string>, lanes: number[]): string | null {
	const ranges: Array<[number, number]> = size >= 2 * LANE_SIZE ? lanes.map(lane => [lane * LANE_SIZE, LANE_SIZE]) : [[0, size]];
	for (const [base, count] of ranges) {
		// Host 0 and the broadcast address are never handed out, and .1 is the founder's.
		const first = Math.max(base, 2);
		const slots = Math.min(base + count, size - 1) - first;
		if (slots <= 0) continue;
		const start = hashOf(peerID) % slots;
		for (let i = 0; i < slots; i++) {
			const candidate = subnetAddress(cidr, first + ((start + i) % slots));
			if (!used.has(candidate)) return candidate;
		}
	}
	return null;
}

/** Lanes members can get: all but the guest lane. */
function memberLanes(size: number): number {
	return guestLane(size) ?? Math.floor(size / LANE_SIZE);
}

/**
 * The lanes this device may take, `[from, to)`. The founding device starts with all of them; each backup it makes
 * hands the top of its range to the device that restores it ({@link OverlayAccess.exportCA}), so no two devices ever
 * take the same lane, whatever they know of each other. Taking one more lane by what a device knows of the others
 * gave two devices one lane: the other device's lane was in no backup this one had seen.
 */
function ownRange(data: FounderData, size: number): [number, number] {
	// Founder data from before ranges: the founding device (lane 0) had all lanes, a restored one only its own.
	return data.laneRange ?? (data.lane ? [data.lane, data.lane + 1] : [0, memberLanes(size)]);
}

/** The lanes this device hands addresses from; none on a device restored from a backup that had no lane left to give. */
function lanesInUse(data: FounderData): number[] {
	return data.lane === undefined && data.laneRange ? [] : [data.lane ?? 0, ...(data.extraLanes ?? [])];
}

/** The lowest lane of the range not taken; null when none is left. */
function nextLane([from, to]: [number, number], taken: number[]): number | null {
	for (let lane = from; lane < to; lane++) if (!taken.includes(lane)) return lane;
	return null;
}

/** A backup takes this share of the subnet's lanes (at least one) for the device that restores it. */
const BACKUP_LANE_SHARE = 16;

/** A lane for a device restored from a backup made before ranges: one no known device holds, at random; with every lane taken it shares one. */
function pickLane(size: number, taken: number[]): number {
	const lanes = memberLanes(size);
	if (lanes < 2) return 0;
	const start = randomInt(lanes - 1);
	for (let i = 0; i < lanes - 1; i++) {
		const lane = 1 + ((start + i) % (lanes - 1));
		if (!taken.includes(lane)) return lane;
	}
	return 1 + randomInt(lanes - 1);
}

/** The member list of a CA backup ({@link OverlayAccess.exportCA}); null for a backup of the key alone. */
function parseMemberList(text: string, subnet: string): Pick<FounderData, 'nextHost' | 'members' | 'revoked' | 'revokedPeers' | 'limits' | 'lanes' | 'laneRange'> | null {
	const body = new RegExp(`${MEMBERS_BEGIN}([\\s\\S]*?)${MEMBERS_END}`).exec(text)?.[1];
	if (body === undefined) return null;
	const invalid = (): CodedError => new CodedError(ErrorCodes.OVERLAY_CERTIFICATE_INVALID, 'the member list of the backup is damaged');
	let list: any;
	try {
		list = JSON.parse(Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'));
	} catch {
		throw invalid();
	}
	if (!Number.isInteger(list?.nextHost) || list.nextHost < 1 || !Array.isArray(list.members)) throw invalid();
	const str = (v: unknown): v is string => typeof v === 'string' && v.length <= 256;
	const members: OverlayMember[] = list.members.map((m: any) => {
		if (!str(m?.name) || !str(m.peerID) || !str(m.vpnIP) || !ipInSubnet(m.vpnIP, subnet) || !str(m.fingerprint) || !FINGERPRINT.test(m.fingerprint) || !str(m.notAfter) || !str(m.issued) || typeof m.revoked !== 'boolean' || !Array.isArray(m.roles) || m.roles.some((r: unknown) => !ROLES.includes(r as OverlayRole))) throw invalid();
		return { name: m.name, ...(m.founder === true ? { founder: true } : {}), peerID: m.peerID, vpnIP: m.vpnIP, roles: [...m.roles], notAfter: m.notAfter, fingerprint: m.fingerprint, issued: m.issued, revoked: m.revoked };
	});
	// Backups made before revocations were carried have none.
	const revoked = list.revoked ?? [];
	if (!Array.isArray(revoked) || revoked.some((f: unknown) => typeof f !== 'string' || !FINGERPRINT.test(f))) throw invalid();
	const revokedPeers = list.revokedPeers ?? {};
	if (typeof revokedPeers !== 'object' || revokedPeers === null || Array.isArray(revokedPeers) || Object.entries(revokedPeers).some(([p, at]) => !str(p) || typeof at !== 'string' || Number.isNaN(Date.parse(at)))) throw invalid();
	const limits = list.limits ?? {};
	if (typeof limits !== 'object' || limits === null || Array.isArray(limits) || Object.entries(limits).some(([p, l]) => !str(p) || !Array.isArray(l) || !l.every(isOverlayLimit))) throw invalid();
	// Backups made before lanes know only the founding device's.
	const lanes = list.lanes ?? [0];
	if (!Array.isArray(lanes) || lanes.some((l: unknown) => !Number.isInteger(l) || (l as number) < 0)) throw invalid();
	// The lanes handed to the device restoring it; backups made before ranges have none.
	const range = list.range;
	if (range !== undefined && (!Array.isArray(range) || range.length !== 2 || !range.every((l: unknown) => Number.isInteger(l) && (l as number) >= 0) || range[0] > range[1])) throw invalid();
	return { nextHost: list.nextHost, members, revoked, revokedPeers, limits, lanes, ...(range ? { laneRange: range as [number, number] } : {}) };
}

export interface OverlayAccessDeps {
	nodes: OverlayNodes;
	getRow(networkID: string): LISHNetworkConfig | undefined;
	/** IDs of every stored protected lishnet. */
	listOverlayIDs(): string[];
	/** Store a new lishnet through the regular catalog path (join included when enabled). */
	addNetwork(config: LISHNetworkConfig): Promise<void>;
	/** Bring a lishnet's runtime in line after its certificate changed: join it if enabled, or reload it. */
	refresh(networkID: string): Promise<void>;
	emit(event: string, data: unknown): void;
}

export interface CreateOverlayNetwork {
	name: string;
	description?: string;
	subnet?: string;
	/** Public `host:port` (UDP) of this node; it then serves as the lishnet's first lighthouse and relay. */
	lighthouseAddr?: string;
	lanDirect?: boolean;
	enabled?: boolean;
}

export interface ApproveOptions {
	/** Expiry of the certificate (ISO 8601); default one year, never past the CA. */
	validUntil?: string;
	/** Infrastructure roles; they need the `infraAddr` the request offered. */
	roles?: OverlayRole[];
}

/**
 * Whether this computer can listen on a UDP port. A lighthouse or relay listens on the port of its public address;
 * when another protected lishnet or program holds it, the lishnet would be created and then never start.
 */
function udpPortFree(addr: string): Promise<boolean> {
	const port = Number(addr.slice(addr.lastIndexOf(':') + 1));
	return new Promise(resolve => {
		const socket = createSocket('udp4');
		socket.once('error', () => resolve(false));
		socket.bind(port, () => socket.close(() => resolve(true)));
	});
}

function pemHex(pem: string): string {
	const body = /-----BEGIN [A-Z0-9 ]+-----([\s\S]*?)-----END/.exec(pem)?.[1] ?? '';
	return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('hex');
}

/**
 * Access to protected lishnets. The founder holds the lishnet's CA key and decides alone who gets in, for how long
 * and in which role: an approval is a certificate, a revocation is a signed state every node enforces. No server
 * is involved — requests and certificates are plain JSON that travel any way (file, chat, an external service
 * calling this API).
 */
export class OverlayAccess {
	private readonly deps: OverlayAccessDeps;
	private readonly founderLocks = new Map<string, Mutex>();
	/** Invites being delivered on this node ({@link deliver}), by lishnet. */
	private readonly deliveries = new Map<string, { stop(): Promise<void> }>();
	private readonly inviteStates = new Map<string, OverlayInviteState>();

	constructor(deps: OverlayAccessDeps) {
		this.deps = deps;
	}

	/** Every revocation known here: the node's (all verified states) and the founder's member list and backups. */
	private async revocations(networkID: string, overlay: LISHOverlayDefinition): Promise<OverlayRevocations> {
		const founder = await this.deps.nodes.store(networkID).readFounder();
		const listed = { fingerprints: [...founder.members.filter(m => m.revoked).map(m => m.fingerprint), ...(founder.revoked ?? [])], peers: founder.revokedPeers ?? {}, ...(founder.limits ? { limits: founder.limits } : {}) };
		return mergeRevocations(await this.deps.nodes.knownRevocations(networkID, overlay), listed);
	}

	private founderLock(networkID: string): Mutex {
		let lock = this.founderLocks.get(networkID);
		if (!lock) this.founderLocks.set(networkID, (lock = new Mutex()));
		return lock;
	}

	private overlayOf(networkID: string): { row: LISHNetworkConfig; overlay: LISHOverlayDefinition; store: OverlayStore } {
		const row = this.deps.getRow(networkID);
		if (!row) throw new CodedError(ErrorCodes.NETWORK_NOT_FOUND, networkID);
		if (!row.overlay) throw new CodedError(ErrorCodes.NETWORK_INVALID, 'not a protected lishnet');
		return { row, overlay: row.overlay, store: this.deps.nodes.store(networkID) };
	}

	private founderOf(networkID: string): { row: LISHNetworkConfig; overlay: LISHOverlayDefinition; store: OverlayStore } {
		const found = this.overlayOf(networkID);
		if (!found.store.has('ca.key')) throw new CodedError(ErrorCodes.OVERLAY_NOT_FOUNDER, networkID);
		return found;
	}

	/** The libp2p peer ID of this node in the lishnet, created on first use. Never the public node's identity. */
	private async nodePeerID(networkID: string, store: OverlayStore): Promise<string> {
		const running = this.deps.nodes.network(networkID)?.getNodeInfo();
		if (running) return running.peerID;
		await store.ensureDir();
		const datastore = new SqliteDatastore(join(store.dir, 'datastore'));
		datastore.open();
		try {
			if (await datastore.has(PRIVATE_KEY_PATH as any)) return peerIdFromPrivateKey(privateKeyFromProtobuf(await datastore.get(PRIVATE_KEY_PATH as any))).toString();
		} finally {
			datastore.close();
		}
		const key = await generateKeyPair('Ed25519');
		await writeIdentityKey(store.dir, privateKeyToProtobuf(key));
		return peerIdFromPrivateKey(key).toString();
	}

	/** This node's Nebula key pair for the lishnet, created on first use; returns the public key (PEM). */
	private async memberKey(store: OverlayStore): Promise<string> {
		const existing = await store.readText('member.pub');
		if (existing && store.has('member.key')) return existing;
		await store.ensureDir();
		await store.remove('member.key');
		const { publicKey } = await runOverlayCommand<{ publicKey: string }>(['keygen', '--out-key', store.path('member.key')]);
		await store.writeText('member.pub', publicKey);
		return publicKey;
	}

	private async issueCertificate(store: OverlayStore, request: { publicKey: string; peerID: string }, vpnIP: string, bits: number, groups: string[], notAfter: string, notBefore?: string): Promise<CertificateInfo> {
		await store.remove('issue.crt');
		await store.writeText('issue.pub', request.publicKey);
		try {
			return await runOverlayCommand<CertificateInfo>(['sign', '--ca-crt', store.path('ca.crt'), '--ca-key', store.path('ca.key'), '--public-key', store.path('issue.pub'), '--name', request.peerID, '--ip', `${vpnIP}/${bits}`, '--groups', groups.join(','), '--not-after', notAfter, ...(notBefore ? ['--not-before', notBefore] : []), '--out-crt', store.path('issue.crt')]);
		} finally {
			await store.remove('issue.pub');
			await store.remove('issue.crt');
		}
	}

	/** Found a protected lishnet: its CA, this node's own certificate (address .1) and the definition. */
	async create(p: CreateOverlayNetwork): Promise<LISHNetworkConfig> {
		const name = p.name?.trim();
		if (!name || name.length > 128) throw new CodedError(ErrorCodes.NETWORK_INVALID, 'a protected lishnet needs a name');
		const subnet = p.subnet ?? DEFAULT_SUBNET;
		const parsed = parseSubnet(subnet);
		if (!parsed) throw new CodedError(ErrorCodes.NETWORK_INVALID, 'subnet must be an aligned IPv4 subnet between /8 and /30');
		if (p.lighthouseAddr !== undefined && !isHostPort(p.lighthouseAddr)) throw new CodedError(ErrorCodes.NETWORK_INVALID, 'lighthouse address must be host:port');
		if (p.lighthouseAddr !== undefined && !(await udpPortFree(p.lighthouseAddr))) throw new CodedError(ErrorCodes.NETWORK_INVALID, `the UDP port of ${p.lighthouseAddr} is already in use on this computer`);
		const networkID = randomUUID();
		const store = this.deps.nodes.store(networkID);
		await store.ensureDir();
		try {
			const ca = await runOverlayCommand<CertificateInfo>(['ca', '--name', name, '--network', subnet, '--out-crt', store.path('ca.crt'), '--out-key', store.path('ca.key')]);
			const peerID = await this.nodePeerID(networkID, store);
			const publicKey = await this.memberKey(store);
			const vpnIP = subnetAddress(subnet, 1);
			const roles: OverlayRole[] = p.lighthouseAddr ? ['lighthouse', 'relay'] : [];
			const cert = await this.issueCertificate(store, { publicKey, peerID }, vpnIP, parsed.bits, ['member', 'founder', ...roles], ca.notAfter);
			await store.writeText('member.crt', cert.cert);
			const host: LISHOverlayHost[] = p.lighthouseAddr ? [{ vpnIP, addr: p.lighthouseAddr, peerID }] : [];
			const founder: FounderData = { nextHost: 2, lane: 0, lanes: [0], members: [{ name, founder: true, peerID, vpnIP, roles, notAfter: cert.notAfter, fingerprint: cert.fingerprint, issued: new Date().toISOString(), revoked: false }], requests: [] };
			await store.writeJSON('founder.json', founder);
			const config: LISHNetworkConfig = {
				networkID,
				name,
				description: p.description ?? '',
				bootstrapPeers: [`/ip4/${vpnIP}/tcp/${OVERLAY_LIBP2P_PORT}/p2p/${peerID}`],
				created: new Date().toISOString(),
				enabled: p.enabled ?? true,
				overlay: { type: 'nebula', caCert: ca.cert, subnet, lighthouses: host, relays: host, lanDirect: p.lanDirect ?? false, version: 0 },
			};
			await this.deps.addNetwork(config);
			return this.deps.getRow(networkID) ?? config;
		} catch (err) {
			await store.removeAll().catch(() => {});
			throw err;
		}
	}

	/**
	 * Create (or return) this node's request for a lishnet. The key pair and the lishnet identity are created here
	 * and never leave the node; the request holds their public halves only.
	 */
	async requestAccess(networkID: string, name: string, infraAddr?: string): Promise<OverlayAccessRequest> {
		const { store } = this.overlayOf(networkID);
		if (infraAddr !== undefined && !isHostPort(infraAddr)) throw new CodedError(ErrorCodes.NETWORK_INVALID, 'infrastructure address must be host:port');
		// A running node of this lishnet holds its own port (a host renewing its certificate).
		if (infraAddr !== undefined && !this.deps.nodes.isRunning(networkID) && !(await udpPortFree(infraAddr))) throw new CodedError(ErrorCodes.NETWORK_INVALID, `the UDP port of ${infraAddr} is already in use on this computer`);
		const request = validateAccessRequest({ type: 'lish-overlay-request', networkID, name, peerID: await this.nodePeerID(networkID, store), publicKey: await this.memberKey(store), ...(infraAddr !== undefined ? { infraAddr } : {}), created: new Date().toISOString() });
		await store.writeJSON('request.json', request);
		await store.remove('refusal.json');
		this.deps.emit('overlay:status', { networkID });
		// A member asking for a renewal is in the lishnet already: the request goes to the founder through it.
		void this.sendRenewal(networkID).catch(() => {});
		return request;
	}

	/** Member: hand its renewal request to the founder over the lishnet (signed by its node, so it cannot be forged). */
	private async sendRenewal(networkID: string): Promise<void> {
		const store = this.deps.nodes.store(networkID);
		if (store.has('ca.key') || store.has('invite.json')) return;
		const request = await store.readRequest();
		if (!request || (await store.readJSON<RenewalRefusal>('refusal.json'))?.requestCreated === request.created) return;
		await this.deps.nodes.broadcastAccess(networkID, { type: 'overlayRenewal', request });
	}

	/**
	 * Every minute on a running lishnet: a member repeats its renewal request, the founder its decisions on renewals of
	 * the last {@link RENEWAL_DELIVERY_MS} (a member that was offline when they were made picks them up later).
	 */
	async repeatAccess(networkID: string): Promise<void> {
		const store = this.deps.nodes.store(networkID);
		if (!store.has('ca.key')) return await this.sendRenewal(networkID);
		const renewals = (await store.readFounder()).renewals ?? {};
		for (const [peerID, decision] of Object.entries(renewals)) if (Date.now() - Date.parse(decision.issued) < RENEWAL_DELIVERY_MS) await this.sendDecision(networkID, peerID, decision);
	}

	private async sendDecision(networkID: string, peerID: string, decision: RenewalDecision): Promise<void> {
		const answer = { peerID, requestCreated: decision.requestCreated, signature: decision.signature };
		const state = decision.bundle ? await this.deps.nodes.store(networkID).readState() : null;
		await this.deps.nodes.broadcastAccess(networkID, decision.refused ? { type: 'overlayRefusal', ...answer } : { type: 'overlayCertificate', ...answer, bundle: { ...decision.bundle, ...(state ? { state } : {}) } });
	}

	/** Founder: sign a decision on a member's renewal and keep it to send out again ({@link repeatAccess}); under the founder lock. */
	private async decideRenewal(networkID: string, data: FounderData, request: OverlayAccessRequest, bundle?: OverlayCertificateBundle): Promise<RenewalDecision> {
		const caKey = (await this.deps.nodes.store(networkID).readText('ca.key'))!;
		const signature = await signAnswer({ networkID, peerID: request.peerID, requestCreated: request.created, ...(bundle ? { certificate: bundle.certificate } : {}) }, caKey);
		// Kept for good, one per member: without the state, which goes along as it is when the decision is sent.
		const decision: RenewalDecision = { requestCreated: request.created, issued: new Date().toISOString(), signature, ...(bundle ? { bundle: { type: bundle.type, networkID: bundle.networkID, certificate: bundle.certificate } } : { refused: true }) };
		data.renewals = { ...data.renewals, [request.peerID]: decision };
		return decision;
	}

	/** A message of the access exchange from the lishnet's state topic; `from` is the author gossipsub verified. */
	async onAccessMessage(networkID: string, message: Record<string, any>, from: string | undefined): Promise<void> {
		if (message['type'] === 'overlayRenewal') await this.takeRenewal(networkID, message['request'], from);
		else if (message['type'] === 'overlayCertificate' || message['type'] === 'overlayRefusal') await this.takeDecision(networkID, message);
	}

	/** Founder: queue a member's renewal; only the member itself can hand in one, and only a member at all. */
	private async takeRenewal(networkID: string, raw: unknown, from: string | undefined): Promise<void> {
		const store = this.deps.nodes.store(networkID);
		if (!store.has('ca.key') || !from) return;
		const request = validateAccessRequest(raw);
		if (request.networkID !== networkID || request.peerID !== from) return;
		const taken = await this.founderLock(networkID).runExclusive(async (): Promise<{ created?: OverlayPendingRequest; decided?: RenewalDecision } | null> => {
			const data = await store.readFounder();
			if (!data.members.some(m => m.peerID === from && !m.revoked)) return null;
			// The same request repeated every minute is queued once. Once decided, the member asking still has not got the
			// answer (it was offline longer than the answer was repeated): it gets it again.
			const decided = data.renewals?.[from];
			if (decided?.requestCreated === request.created) return { decided };
			if (data.requests.some(r => r.peerID === from && r.created === request.created)) return null;
			const kept = data.requests.filter(r => r.peerID !== from);
			if (kept.length >= MAX_PENDING_REQUESTS) return null;
			const entry: OverlayPendingRequest = { ...request, id: randomUUID(), received: new Date().toISOString(), renewal: true };
			data.requests = [...kept, entry];
			await store.writeJSON('founder.json', data);
			return { created: entry };
		});
		if (taken?.decided && Date.now() - Date.parse(taken.decided.issued) >= RENEWAL_DELIVERY_MS) await this.sendDecision(networkID, from, taken.decided);
		if (taken?.created) this.deps.emit('overlay:request', taken.created);
	}

	/**
	 * Member: the founder's decision on its own pending renewal — the certificate to import, or a refusal to show. Only
	 * the one the CA signed for the request this node is waiting on: anyone in the lishnet can send these messages.
	 */
	private async takeDecision(networkID: string, message: Record<string, any>): Promise<void> {
		const { overlay, store } = this.overlayOf(networkID);
		if (store.has('ca.key')) return;
		const request = await store.readRequest();
		if (!request || message['peerID'] !== request.peerID || message['requestCreated'] !== request.created) return;
		const refused = message['type'] === 'overlayRefusal';
		const certificate = message['bundle']?.certificate;
		if (!refused && typeof certificate !== 'string') return;
		const answer = { networkID, peerID: request.peerID, requestCreated: request.created, ...(refused ? {} : { certificate }) };
		if (!(await verifyAnswer(answer, message['signature'], await this.deps.nodes.caPublicKey(store, overlay.caCert)))) return void console.warn(`[Overlay ${networkID.slice(0, 8)}] ignored a renewal answer the CA did not sign`);
		if (refused) {
			if ((await store.readJSON<RenewalRefusal>('refusal.json'))?.requestCreated === request.created) return;
			await store.writeJSON('refusal.json', { requestCreated: request.created } satisfies RenewalRefusal);
			this.deps.emit('overlay:status', { networkID });
			return void console.log(`[Overlay ${networkID.slice(0, 8)}] the founder refused the renewal`);
		}
		await this.importCertificate(message['bundle']);
		console.log(`[Overlay ${networkID.slice(0, 8)}] the renewed certificate came over the lishnet`);
	}

	/** Founder: take a member's request into the queue. A newer request of the same node replaces its older one. */
	async importRequest(raw: unknown): Promise<OverlayPendingRequest> {
		const request = validateAccessRequest(raw);
		const { store } = this.founderOf(request.networkID);
		const pending = await this.founderLock(request.networkID).runExclusive(async () => {
			const data = await store.readFounder();
			const kept = data.requests.filter(r => r.peerID !== request.peerID);
			if (kept.length >= MAX_PENDING_REQUESTS) throw new CodedError(ErrorCodes.NETWORK_INVALID, 'too many pending requests');
			const entry: OverlayPendingRequest = { ...request, id: randomUUID(), received: new Date().toISOString() };
			data.requests = [...kept, entry];
			await store.writeJSON('founder.json', data);
			return entry;
		});
		this.deps.emit('overlay:request', pending);
		return pending;
	}

	async listRequests(networkID: string): Promise<OverlayPendingRequest[]> {
		return (await this.founderOf(networkID).store.readFounder()).requests;
	}

	async rejectRequest(networkID: string, requestID: string): Promise<boolean> {
		const { store } = this.founderOf(networkID);
		const removed = await this.founderLock(networkID).runExclusive(async () => {
			const data = await store.readFounder();
			const request = data.requests.find(r => r.id === requestID);
			if (!request) return null;
			// The invited node learns of it the next time it asks.
			const invite = data.invites?.find(i => i.id === request.invite);
			if (invite) invite.refused = true;
			// A member renewing over the lishnet is told, and its request repeated every minute stays decided.
			const decision = request.renewal ? await this.decideRenewal(networkID, data, request) : null;
			data.requests = data.requests.filter(r => r.id !== requestID);
			await store.writeJSON('founder.json', data);
			return { peerID: request.peerID, decision };
		});
		if (removed?.decision) await this.sendDecision(networkID, removed.peerID, removed.decision);
		if (removed) this.deps.emit('overlay:members', { networkID });
		return removed !== null;
	}

	/**
	 * Founder: approve a request. Issues the certificate (name = the member's peer ID, its own overlay address,
	 * expiry), and when roles are given adds the member to the lishnet's lighthouses or relays in a new signed state.
	 */
	async approve(networkID: string, requestID: string, opts: ApproveOptions = {}): Promise<OverlayCertificateBundle> {
		const { overlay, store } = this.founderOf(networkID);
		const roles = [...new Set(opts.roles ?? [])];
		if (roles.some(r => !ROLES.includes(r))) throw new CodedError(ErrorCodes.NETWORK_INVALID, 'unknown role');
		const until = opts.validUntil ? new Date(opts.validUntil) : new Date(Date.now() + DEFAULT_MEMBER_DAYS * 86_400_000);
		if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) throw new CodedError(ErrorCodes.NETWORK_INVALID, 'validity must end in the future');
		const approved = await this.founderLock(networkID).runExclusive(async () => {
			const data = await store.readFounder();
			// A change the new state cannot carry is undone whole: it must not block every later state (a revocation).
			const before = structuredClone(data);
			const request = data.requests.find(r => r.id === requestID);
			if (!request) throw new CodedError(ErrorCodes.OVERLAY_REQUEST_NOT_FOUND, requestID);
			if (roles.length > 0 && !request.infraAddr) throw new CodedError(ErrorCodes.NETWORK_INVALID, 'an infrastructure role needs the public address the request offers');
			const subnet = parseSubnet(overlay.subnet)!;
			// A renewal keeps the address the member already had; a new member gets a free one.
			const current = data.members.filter(m => m.peerID === request.peerID && !m.revoked);
			const previous = current[0];
			let vpnIP = previous?.vpnIP;
			if (!vpnIP) {
				// Beyond the member list: a CA restored from the key alone knows no members, but the founder's address, its
				// own and the hosts' are still taken.
				const own = await this.deps.nodes.ownCertificate(store, overlay.caCert).catch(() => null);
				const used = new Set([...data.members.map(m => m.vpnIP), subnetAddress(overlay.subnet, 1), ...(own ? [own.networks[0]!.split('/')[0]!] : []), ...overlay.lighthouses.map(h => h.vpnIP), ...overlay.relays.map(h => h.vpnIP)]);
				const mine = lanesInUse(data);
				let free = mine.length > 0 ? freeAddress(overlay.subnet, subnet.size, request.peerID, used, mine) : null;
				if (!free) {
					// This device's lanes are full: it takes the next one of its own range.
					const lane = nextLane(ownRange(data, subnet.size), [...(data.lanes ?? [0]), ...mine]);
					free = lane === null ? null : freeAddress(overlay.subnet, subnet.size, request.peerID, used, [lane]);
					if (!free) throw new CodedError(ErrorCodes.OVERLAY_ADDRESSES_EXHAUSTED, overlay.subnet);
					data.extraLanes = [...(data.extraLanes ?? []), lane!];
					data.lanes = [...new Set([...(data.lanes ?? [0]), lane!])];
				}
				vpnIP = free;
			}
			const notAfter = until.toISOString().replace(/\.\d{3}Z$/, 'Z');
			// The new certificate starts after every earlier decision on the member: after its revocation (which keeps
			// every older certificate out, also one another device issued) and after the start of its last approval (whose
			// limit below must not reach this one). Certificates count whole seconds; a start still ahead is waited for.
			const known = mergeRevocations(await this.revocations(networkID, overlay), { fingerprints: [], peers: data.revokedPeers ?? {}, ...(data.limits ? { limits: data.limits } : {}) });
			const limits = known.limits?.[request.peerID] ?? [];
			const earlier = [known.peers[request.peerID], ...limits.map(l => l[0])].filter((t): t is string => t !== undefined).map(t => Math.floor(Date.parse(t) / 1000) + 1);
			const after = Math.max(Math.floor((Date.now() - 60_000) / 1000), ...earlier) * 1000;
			if (after > Date.now()) await Bun.sleep(after - Date.now());
			const notBefore = new Date(after).toISOString().replace(/\.\d{3}Z$/, 'Z');
			const cert = await this.issueCertificate(store, request, vpnIP, subnet.bits, ['member', ...roles], notAfter, notBefore);
			// The newest decision on how long the member stays bounds its older certificates: a longer one, also one another
			// device holding the CA key issued, ends with this one. They stay valid until then, so a member offline now still
			// gets this certificate over the lishnet. What this device knew of other devices' approvals goes along: their
			// clocks do not order decisions, so one it did not know of is weighed by its length instead (limitCaps).
			data.device ??= randomBytes(4).toString('hex');
			const seen: Record<string, string> = {};
			for (const l of limits) if (l[2] !== undefined && l[2] !== data.device && (!seen[l[2]] || Date.parse(l[0]) > Date.parse(seen[l[2]]!))) seen[l[2]] = l[0];
			data.limits = { ...data.limits, [request.peerID]: [...(data.limits?.[request.peerID] ?? []), [cert.notBefore, cert.notAfter, data.device, seen, cert.fingerprint]] };
			const member: OverlayMember = { name: request.name, peerID: request.peerID, vpnIP, roles, notAfter: cert.notAfter, fingerprint: cert.fingerprint, issued: new Date().toISOString(), revoked: false };
			data.members.push(member);
			data.requests = data.requests.filter(r => r.id !== requestID);
			await store.writeJSON('founder.json', data);
			// Every approval signs a new state: the limit above, and the roles given or taken away by a renewal without them.
			const host: LISHOverlayHost = { vpnIP, addr: request.infraAddr ?? '', peerID: request.peerID };
			const others = (list: LISHOverlayHost[]): LISHOverlayHost[] => list.filter(h => h.vpnIP !== host.vpnIP);
			const hostsChange = roles.length > 0 || current.some(m => m.roles.length > 0);
			try {
				await this.publishLocked(networkID, o => (hostsChange ? { lighthouses: roles.includes('lighthouse') ? [...others(o.lighthouses), host] : others(o.lighthouses), relays: roles.includes('relay') ? [...others(o.relays), host] : others(o.relays) } : { lighthouses: o.lighthouses, relays: o.relays }), []);
			} catch (err) {
				await store.writeJSON('founder.json', before);
				throw err;
			}
			const state = await store.readState();
			const bundle: OverlayCertificateBundle = { type: 'lish-overlay-certificate', networkID, certificate: cert.cert, ...(state ? { state } : {}) };
			// Recorded with the approval, under the same lock: a request handed in again meanwhile finds it decided.
			// One that came through an invite gets its certificate back the same way, when the node asks next.
			const invite = request.invite ? data.invites?.find(i => i.id === request.invite) : undefined;
			if (invite) invite.bundle = bundle;
			// A renewal handed in over the lishnet gets its certificate over the lishnet: now, and again every minute for a while.
			const decision = request.renewal ? await this.decideRenewal(networkID, data, request, bundle) : null;
			if (invite || decision) await store.writeJSON('founder.json', data);
			return { bundle, decision, peerID: request.peerID };
		});
		if (approved.decision) await this.sendDecision(networkID, approved.peerID, approved.decision);
		this.deps.emit('overlay:members', { networkID });
		return approved.bundle;
	}

	/**
	 * Founder: an invite ({@link OverlayInvite}) as one line of text. Its guest certificate gets an address in the guest
	 * lane and lasts `validDays`; the request that comes through it waits among the others for the founder's decision.
	 */
	async createInvite(networkID: string, validDays: number = DEFAULT_INVITE_DAYS): Promise<string> {
		const { row, overlay, store } = this.founderOf(networkID);
		const subnet = parseSubnet(overlay.subnet)!;
		const lane = guestLane(subnet.size);
		if (lane === null) throw new CodedError(ErrorCodes.NETWORK_INVALID, 'invites need a lishnet subnet of /22 or larger');
		if (!Number.isFinite(validDays) || validDays <= 0 || validDays > MAX_INVITE_DAYS) throw new CodedError(ErrorCodes.NETWORK_INVALID, `an invite lasts 1 to ${MAX_INVITE_DAYS} days`);
		const own = await this.deps.nodes.ownCertificate(store, overlay.caCert).catch(() => null);
		if (!own) throw new CodedError(ErrorCodes.NETWORK_INVALID, 'this device has no certificate of its own in the lishnet yet');
		const id = randomUUID();
		const expires = new Date(Date.now() + validDays * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
		const issued = await this.founderLock(networkID).runExclusive(async () => {
			const data = await store.readFounder();
			const live = (data.invites ?? []).filter(i => Date.parse(i.expires) > Date.now());
			const used = new Set(live.map(i => i.vpnIP));
			// Host .255 of the last lane is the subnet's broadcast address.
			const slots = Math.min(LANE_SIZE, subnet.size - 1 - lane * LANE_SIZE);
			const start = hashOf(id) % slots;
			let vpnIP: string | undefined;
			for (let i = 0; i < slots && !vpnIP; i++) {
				const candidate = subnetAddress(overlay.subnet, lane * LANE_SIZE + ((start + i) % slots));
				if (!used.has(candidate)) vpnIP = candidate;
			}
			if (!vpnIP) throw new CodedError(ErrorCodes.OVERLAY_ADDRESSES_EXHAUSTED, 'too many open invites');
			await store.remove('issue.key');
			const { publicKey } = await runOverlayCommand<{ publicKey: string }>(['keygen', '--out-key', store.path('issue.key')]);
			try {
				const cert = await this.issueCertificate(store, { publicKey, peerID: GUEST_NAME_PREFIX + id }, vpnIP, subnet.bits, [GUEST_GROUP], expires);
				const key = (await store.readText('issue.key'))!;
				data.invites = [...live, { id, vpnIP, expires }];
				await store.writeJSON('founder.json', data);
				return { cert: cert.cert, key };
			} finally {
				await store.remove('issue.key');
			}
		});
		return encodeInvite({ type: 'lish-overlay-invite', id, network: { networkID, name: row.name, description: row.description, bootstrapPeers: row.bootstrapPeers, overlay }, founder: own.networks[0]!.split('/')[0]!, cert: issued.cert, key: issued.key, expires });
	}

	/**
	 * Founder: a connection from an invite's guest. It is answered with the invite exchange and closed; anything else
	 * (a member) goes on to libp2p. Every node but a founder's refuses guests in its firewall already.
	 */
	async serveGuest(networkID: string, socket: Socket, remoteIP: string): Promise<boolean> {
		if (!this.deps.nodes.store(networkID).has('ca.key')) return false;
		const name = (await this.deps.nodes.helperStatus(networkID))?.hosts.find(h => h.vpnAddrs.includes(remoteIP))?.name;
		if (!name?.startsWith(GUEST_NAME_PREFIX)) return false;
		void answerGuest(socket, message => this.answerInvite(networkID, name.slice(GUEST_NAME_PREFIX.length), remoteIP, message));
		return true;
	}

	/** The founder's answer to a guest: its request goes into the queue once, and its certificate back once issued. */
	private async answerInvite(networkID: string, inviteID: string, remoteIP: string, raw: unknown): Promise<OverlayInviteAnswer> {
		const refused = (reason: string): OverlayInviteAnswer => ({ status: 'refused', reason });
		const message = raw as { invite?: unknown; request?: unknown } | null;
		if (message?.invite !== inviteID) return refused('the message is for another invite');
		const request = validateAccessRequest(message.request);
		if (request.networkID !== networkID) return refused('the request is for another lishnet');
		const { store } = this.founderOf(networkID);
		const result = await this.founderLock(networkID).runExclusive(async (): Promise<{ answer: OverlayInviteAnswer; created?: OverlayPendingRequest }> => {
			const data = await store.readFounder();
			const invite = data.invites?.find(i => i.id === inviteID);
			// The address binds the guest certificate to its invite, beyond the name.
			if (!invite || invite.vpnIP !== remoteIP || Date.parse(invite.expires) <= Date.now()) return { answer: refused('the invite is unknown or has expired') };
			if (invite.peerID && invite.peerID !== request.peerID) return { answer: refused('the invite was used by another node') };
			if (invite.refused) return { answer: refused('the founder refused the request') };
			if (invite.bundle) return { answer: { status: 'approved', bundle: invite.bundle } };
			invite.peerID = request.peerID;
			let created: OverlayPendingRequest | undefined;
			if (!data.requests.some(r => r.invite === inviteID)) {
				const kept = data.requests.filter(r => r.peerID !== request.peerID);
				if (kept.length >= MAX_PENDING_REQUESTS) return { answer: refused('too many pending requests') };
				created = { ...request, id: randomUUID(), received: new Date().toISOString(), invite: inviteID };
				data.requests = [...kept, created];
			}
			await store.writeJSON('founder.json', data);
			return { answer: { status: 'pending' }, ...(created ? { created } : {}) };
		});
		if (result.created) this.deps.emit('overlay:request', result.created);
		return result.answer;
	}

	/**
	 * Member: join through an invite. The lishnet is added when new, the request is made here (keys never leave), and
	 * the node then hands it to the founder and picks up its certificate by itself ({@link deliver}).
	 */
	async useInvite(text: string, name: string, infraAddr?: string): Promise<OverlayStatus> {
		const invite = decodeInvite(text);
		if (Date.parse(invite.expires) <= Date.now()) throw new CodedError(ErrorCodes.NETWORK_INVALID, 'the invite has expired');
		const networkID = invite.network.networkID;
		const existing = this.deps.getRow(networkID);
		if (existing && existing.overlay?.caCert !== invite.network.overlay.caCert) throw new CodedError(ErrorCodes.NETWORK_INVALID, 'another lishnet with this ID exists here');
		if (!existing) await this.deps.addNetwork({ ...invite.network, created: new Date().toISOString(), enabled: true });
		const { store } = this.overlayOf(networkID);
		if (store.has('ca.key')) throw new CodedError(ErrorCodes.NETWORK_INVALID, "this device holds the lishnet's CA key");
		await this.requestAccess(networkID, name, infraAddr);
		await this.stopInvite(networkID);
		await store.writeText('guest.crt', invite.cert);
		await store.writeText('guest.key', invite.key);
		await store.writeJSON('invite.json', { id: invite.id, founder: invite.founder, expires: invite.expires } satisfies InviteFile);
		this.inviteStates.set(networkID, 'delivering');
		this.deliver(networkID);
		return await this.status(networkID);
	}

	/** Resume the delivery of every invite of an enabled lishnet (at start). */
	resumeInvites(): void {
		for (const networkID of this.deps.listOverlayIDs()) this.resumeInvite(networkID);
	}

	/** Resume the lishnet's invite delivery when it is enabled and has one (it was switched on again). */
	resumeInvite(networkID: string): void {
		if (this.deps.getRow(networkID)?.enabled === true && this.deps.nodes.store(networkID).has('invite.json')) this.deliver(networkID);
	}

	async stopInvites(): Promise<void> {
		for (const networkID of [...this.deliveries.keys()]) await this.stopInvite(networkID);
	}

	/** Stop delivering the lishnet's invite: it is being deleted, replaced by a new one, or done with. */
	async stopInvite(networkID: string): Promise<void> {
		await this.deliveries.get(networkID)?.stop();
		this.inviteStates.delete(networkID);
	}

	/**
	 * Hand the invited node's request to the founder through a guest helper, every {@link INVITE_RETRY_MS} until the
	 * founder answers with the certificate, refuses, or the invite expires. While the founder is offline it waits.
	 */
	private deliver(networkID: string): void {
		if (this.deliveries.has(networkID)) return;
		const tag = `[Overlay ${networkID.slice(0, 8)}]`;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let guest: { helper: OverlayHelper; vpnIP: string } | null = null;
		const setState = (state: OverlayInviteState): void => {
			if (this.inviteStates.get(networkID) === state) return;
			this.inviteStates.set(networkID, state);
			this.deps.emit('overlay:status', { networkID });
		};
		const stop = async (): Promise<void> => {
			stopped = true;
			clearTimeout(timer);
			this.deliveries.delete(networkID);
			await guest?.helper.stop();
			guest = null;
		};
		const attempt = async (): Promise<void> => {
			const store = this.deps.nodes.store(networkID);
			const invite = await store.readJSON<InviteFile>('invite.json').catch(() => null);
			const request = await store.readRequest().catch(() => null);
			const row = this.deps.getRow(networkID);
			const overlay = row?.overlay;
			if (stopped) return;
			// A switched-off lishnet talks to nobody; switching it on resumes the delivery.
			if (!invite || !request || !overlay || row?.enabled !== true) return void (await stop());
			if (Date.parse(invite.expires) <= Date.now()) {
				setState('expired');
				return void (await stop());
			}
			try {
				if (!guest?.helper.isRunning()) {
					const started = await this.deps.nodes.startGuest(networkID, overlay);
					// Stopped while the helper was starting: the stop found none to end, so this one ends it.
					if (stopped) return void (await started.helper.stop());
					guest = started;
				}
				const answer = await askFounder(guest.helper, invite.founder, { invite: invite.id, request });
				if (stopped) return;
				if (answer.status === 'approved') {
					await this.importCertificate(answer.bundle);
					console.log(`${tag} the certificate came through the invite`);
					return;
				}
				if (answer.status === 'refused') {
					console.warn(`${tag} the invite was refused: ${answer.reason}`);
					setState('refused');
					return void (await stop());
				}
				setState('pending');
			} catch (err: any) {
				console.debug(`${tag} invite delivery: ${err?.message ?? err}`);
			}
			if (!stopped) timer = setTimeout(() => void attempt(), INVITE_RETRY_MS);
		};
		this.deliveries.set(networkID, { stop });
		void attempt();
	}

	/** The invite is done with (its certificate arrived): its files and its guest helper go. */
	private async endInvite(networkID: string, store: OverlayStore): Promise<void> {
		if (!store.has('invite.json')) return;
		await this.stopInvite(networkID);
		for (const file of ['invite.json', 'guest.crt', 'guest.key', 'guest.yml'] as const) await store.remove(file);
	}

	/** Founder: import a request and approve it in one call — the shape an external service usually wants. */
	async issue(raw: unknown, opts: ApproveOptions = {}): Promise<OverlayCertificateBundle> {
		const pending = await this.importRequest(raw);
		return await this.approve(pending.networkID, pending.id, opts);
	}

	async listMembers(networkID: string): Promise<OverlayMember[]> {
		return (await this.founderOf(networkID).store.readFounder()).members;
	}

	/**
	 * Founder: revoke a member for good — the certificate with this fingerprint and every other one its node still
	 * holds (an earlier one stays valid after a renewal). Every node blocklists them as soon as the signed state
	 * reaches it, and with `disconnect_invalid` their tunnels drop at once. A revoked host leaves the infrastructure.
	 */
	async revoke(networkID: string, fingerprint: string): Promise<void> {
		const { overlay, store } = this.founderOf(networkID);
		if (!FINGERPRINT.test(fingerprint)) throw new CodedError(ErrorCodes.NETWORK_INVALID, 'fingerprint must be 64 hex characters');
		// The founder's own node is the lishnet's authority (and usually its lighthouse): revoking it locks everyone out.
		const own = await this.deps.nodes.ownCertificate(store, overlay.caCert);
		await this.founderLock(networkID).runExclusive(async () => {
			const data = await store.readFounder();
			const member = data.members.find(m => m.fingerprint === fingerprint);
			if (own && (own.fingerprint === fingerprint || member?.peerID === own.name)) throw new CodedError(ErrorCodes.NETWORK_INVALID, "the founder's own certificate cannot be revoked");
			const node = member ? data.members.filter(m => m.peerID === member.peerID && !m.revoked) : [];
			for (const m of node) m.revoked = true;
			// The member itself, not only the certificates this device issued: one another device holding the CA key
			// issued (a renewal after a restore) is revoked too, as is every certificate of the node issued before now.
			if (member) data.revokedPeers = { ...data.revokedPeers, [member.peerID]: new Date().toISOString() };
			if (member) await store.writeJSON('founder.json', data);
			const keep = (list: LISHOverlayHost[]): LISHOverlayHost[] => (member ? list.filter(h => h.vpnIP !== member.vpnIP || h.peerID !== member.peerID) : list);
			await this.publishLocked(networkID, o => ({ lighthouses: keep(o.lighthouses), relays: keep(o.relays) }), [fingerprint, ...node.map(m => m.fingerprint)]);
		});
		this.deps.emit('overlay:members', { networkID });
	}

	/** Founder: replace the lishnet's lighthouses and relays. */
	async setHosts(networkID: string, lighthouses: unknown, relays: unknown): Promise<void> {
		const { overlay } = this.founderOf(networkID);
		const lh = validateOverlayHosts(lighthouses, overlay.subnet, 'lighthouses');
		const rl = validateOverlayHosts(relays, overlay.subnet, 'relays');
		await this.founderLock(networkID).runExclusive(() => this.publishLocked(networkID, () => ({ lighthouses: lh, relays: rl }), []));
	}

	/**
	 * Sign and publish a new state built from the stored hosts and revocations, under the founder lock: two changes
	 * that each start from the hosts they read first would otherwise lose one another's host.
	 *
	 * Every revocation in the member list goes in as well: a founder restored on a device that never held the signed
	 * state would otherwise sign one without the earlier revocations, and members would unblock those certificates.
	 */
	private async publishLocked(networkID: string, hosts: (overlay: LISHOverlayDefinition) => Pick<LISHOverlayDefinition, 'lighthouses' | 'relays'>, revoke: string[]): Promise<void> {
		const { overlay } = this.overlayOf(networkID);
		const known = await this.revocations(networkID, overlay);
		await this.deps.nodes.publishNewState(networkID, { ...hosts(overlay), revoked: [...new Set([...known.fingerprints, ...revoke])], revokedPeers: known.peers, ...(known.limits ? { limits: known.limits } : {}) });
	}

	/**
	 * Member: import the founder's answer. The certificate must be for this node's own key and identity and signed
	 * by the lishnet's CA; the state that comes with it is verified like any other.
	 */
	async importCertificate(raw: unknown): Promise<OverlayStatus> {
		if (typeof raw !== 'object' || raw === null || (raw as any).type !== 'lish-overlay-certificate') throw new CodedError(ErrorCodes.OVERLAY_CERTIFICATE_INVALID, 'not a certificate bundle');
		const bundle = raw as OverlayCertificateBundle;
		if (typeof bundle.certificate !== 'string' || bundle.certificate.length > 8192) throw new CodedError(ErrorCodes.OVERLAY_CERTIFICATE_INVALID, 'malformed certificate');
		const { overlay, store } = this.overlayOf(bundle.networkID);
		const publicKey = await store.readText('member.pub');
		if (!publicKey || !store.has('member.key')) throw new CodedError(ErrorCodes.OVERLAY_CERTIFICATE_INVALID, 'this node never requested access to the lishnet');
		await this.deps.nodes.caPublicKey(store, overlay.caCert);
		await store.remove('issue.crt');
		await store.writeText('issue.crt', bundle.certificate);
		try {
			const info = await runOverlayCommand<CertificateInfo>(['print', '--crt', store.path('issue.crt'), '--ca', store.path('ca.crt')], ErrorCodes.OVERLAY_CERTIFICATE_INVALID);
			if (info.publicKey !== pemHex(publicKey)) throw new CodedError(ErrorCodes.OVERLAY_CERTIFICATE_INVALID, 'the certificate is for another key');
			if (info.name !== (await this.nodePeerID(bundle.networkID, store))) throw new CodedError(ErrorCodes.OVERLAY_CERTIFICATE_INVALID, 'the certificate is for another node');
			if (Date.parse(info.notAfter) <= Date.now()) throw new CodedError(ErrorCodes.OVERLAY_CERTIFICATE_INVALID, `the certificate expired on ${info.notAfter}`);
			if (bundle.state) await this.deps.nodes.acceptState(bundle.networkID, bundle.state);
			await store.writeText('member.crt', info.cert);
			const answered = await store.readRequest();
			if (answered) await store.writeJSON('last-request.json', answered);
			await store.remove('request.json');
			await store.remove('refusal.json');
		} finally {
			await store.remove('issue.crt');
		}
		await this.endInvite(bundle.networkID, store);
		await this.deps.refresh(bundle.networkID);
		this.deps.emit('overlay:status', { networkID: bundle.networkID });
		return await this.status(bundle.networkID);
	}

	/**
	 * Founder: a backup of the CA key with the member list, for a restore or a second device that should be able to
	 * approve and revoke as well. Without the list a restored node would hand out addresses already in use and could
	 * revoke only the certificates it is told about. Every revocation of the signed state goes in too: one made on
	 * another device holding the key is in this node's state but not in its member list.
	 */
	async exportCA(networkID: string, forDevice: boolean = false): Promise<{ networkID: string; caKey: string }> {
		const { overlay, store } = this.founderOf(networkID);
		const size = parseSubnet(overlay.subnet)!.size;
		// A backup hands the device that restores it lanes of its own, taken off the top of this device's range. Plain
		// backups all hand the same ones, taken once: kept for safety, they must not use this device's addresses up. One
		// made for another device that approves alongside (`forDevice`) takes new ones. A subnet without lanes hands none.
		const { range, ...data } = await this.founderLock(networkID).runExclusive(async () => {
			const data = await store.readFounder();
			if (size < 2 * LANE_SIZE) return { ...data, range: undefined };
			if (!forDevice && data.backupRange) return { ...data, range: data.backupRange };
			const [from, to] = ownRange(data, size);
			const cut = Math.max(from, ...lanesInUse(data).map(l => l + 1), to - Math.max(1, Math.floor(memberLanes(size) / BACKUP_LANE_SHARE)));
			// A backup whose restore could issue no certificate, not even the device's own, is refused before it is made.
			if (cut >= to) throw new CodedError(ErrorCodes.OVERLAY_ADDRESSES_EXHAUSTED, 'no addresses left to hand to another device');
			data.laneRange = [from, cut];
			if (!forDevice) data.backupRange = [cut, to];
			await store.writeJSON('founder.json', data);
			return { ...data, range: [cut, to] as [number, number] };
		});
		const known = await this.revocations(networkID, overlay);
		const taken = [...new Set([...(data.lanes ?? [0]), ...lanesInUse(data)])];
		const list = Buffer.from(JSON.stringify({ nextHost: data.nextHost, members: data.members, revoked: known.fingerprints, revokedPeers: known.peers, limits: known.limits ?? {}, lanes: taken, ...(range ? { range } : {}) })).toString('base64');
		return { networkID, caKey: `${(await store.readText('ca.key'))!.trim()}\n${MEMBERS_BEGIN}\n${list.replace(/.{1,64}/g, '$&\n')}${MEMBERS_END}\n` };
	}

	/** Restore the CA key (and the member list, when the backup has one). The key must belong to the lishnet's CA certificate. */
	async importCA(networkID: string, caKey: string): Promise<void> {
		const { overlay, store } = this.overlayOf(networkID);
		const pem = /-----BEGIN NEBULA ED25519 PRIVATE KEY-----([\s\S]*?)-----END NEBULA ED25519 PRIVATE KEY-----/.exec(caKey ?? '');
		const raw = pem ? Buffer.from(pem[1]!.replace(/\s+/g, ''), 'base64') : Buffer.alloc(0);
		if (raw.length !== 64) throw new CodedError(ErrorCodes.OVERLAY_CERTIFICATE_INVALID, 'not a CA key');
		// The public half is derived from the seed, not read from the key's second half, which anyone can copy.
		const derived = Buffer.from((await generateKeyPairFromSeed('Ed25519', raw.subarray(0, 32))).publicKey.raw).toString('hex');
		if (derived !== (await this.deps.nodes.caPublicKey(store, overlay.caCert))) throw new CodedError(ErrorCodes.OVERLAY_CERTIFICATE_INVALID, 'the key does not belong to this lishnet');
		const backup = parseMemberList(caKey, overlay.subnet);
		// Refused before anything is kept: restored, it could not issue this device its own certificate.
		if (backup?.laneRange && backup.laneRange[0] >= backup.laneRange[1]) throw new CodedError(ErrorCodes.OVERLAY_ADDRESSES_EXHAUSTED, 'the backup hands over no addresses; make a new one');
		await this.founderLock(networkID).runExclusive(async () => {
			await store.writeText('ca.key', pem![0] + '\n');
			const data = await store.readFounder();
			// A device taking the key over gets lanes of its own: the range the backup hands over, or with a backup made
			// before ranges (or the key alone) one lane apart from the ones the backup knows. A device that took lanes it
			// never used (a restore that failed after) takes the new backup's.
			const taken = [...new Set([...(data.lanes ?? []), ...(backup?.lanes ?? [0])])];
			if (data.lane === undefined) {
				if (backup?.laneRange) {
					data.laneRange = backup.laneRange;
					if (backup.laneRange[0] < backup.laneRange[1]) data.lane = backup.laneRange[0];
				} else {
					delete data.laneRange;
					data.lane = pickLane(parseSubnet(overlay.subnet)!.size, taken);
				}
			}
			data.lanes = [...new Set([...taken, ...lanesInUse(data)])];
			for (const m of backup?.members ?? []) {
				const held = data.members.find(h => h.fingerprint === m.fingerprint);
				if (held) held.revoked ||= m.revoked;
				else data.members.push(m);
			}
			data.nextHost = Math.max(data.nextHost, backup?.nextHost ?? 1);
			const merged = mergeRevocations({ fingerprints: data.revoked ?? [], peers: data.revokedPeers ?? {}, ...(data.limits ? { limits: data.limits } : {}) }, { fingerprints: backup?.revoked ?? [], peers: backup?.revokedPeers ?? {}, ...(backup?.limits ? { limits: backup.limits } : {}) });
			if (merged.fingerprints.length > 0) data.revoked = merged.fingerprints;
			if (Object.keys(merged.peers).length > 0) data.revokedPeers = merged.peers;
			if (merged.limits) data.limits = merged.limits;
			await store.writeJSON('founder.json', data);
		});
		// A clean device has no certificate of its own, and the screens offer a founder no request to make.
		await this.ensureOwnMembership(networkID);
		// A node already running keeps its old blocklist otherwise: the backup's revocations apply now, not with the next state.
		await this.deps.nodes.reconfigure(networkID);
		// An open tunnel of a member the backup revokes may run on a certificate the backup does not list (issued by another
		// device): it is found and blocked now, not with the next periodic sweep a minute later.
		await this.deps.nodes.sweepRevokedPeers(networkID);
		this.deps.emit('overlay:status', { networkID });
	}

	/**
	 * Founder: sign this node's own membership again when it has none it can use — missing, revoked, expired or
	 * ending within {@link OWN_RENEWAL_MS}. The screens offer a founder no request to make, so without this a founder
	 * whose certificate ran out could approve others but not take part itself. Returns whether it renewed.
	 */
	async ensureOwnMembership(networkID: string): Promise<boolean> {
		const { overlay, store, row } = this.overlayOf(networkID);
		if (!store.has('ca.key')) return false;
		const own = await this.deps.nodes.ownCertificate(store, overlay.caCert).catch(() => null);
		// Revoked as far as anything here knows: the signed states, and the member list and revocations of a backup.
		const revoked = own ? isRevoked(await this.revocations(networkID, overlay), own) : false;
		if (own && !revoked && Date.parse(own.notAfter) - Date.now() > OWN_RENEWAL_MS) return false;
		// A renewal keeps the lighthouse and relay roles the node holds (usually the founder's own): one without them
		// would take the node out of the lishnet's infrastructure.
		const ownIP = own && !revoked ? own.networks[0]?.split('/')[0] : undefined;
		const host = [...overlay.lighthouses, ...overlay.relays].find(h => h.vpnIP === ownIP);
		const roles: OverlayRole[] = ROLES.filter(r => (r === 'lighthouse' ? overlay.lighthouses : overlay.relays).some(h => h.vpnIP === ownIP));
		const request = await this.requestAccess(networkID, row.name.slice(0, 64), host?.addr);
		await this.importCertificate(await this.issue(request, roles.length > 0 ? { roles } : {}));
		return true;
	}

	async status(networkID: string): Promise<OverlayStatus> {
		const { overlay, store } = this.overlayOf(networkID);
		const nodes = this.deps.nodes;
		const cert = await nodes.ownCertificate(store, overlay.caCert).catch(() => null);
		const state = await nodes.currentState(networkID, overlay);
		const helper = await nodes.helperStatus(networkID);
		const tunnels = new Map((helper?.hosts ?? []).map(h => [h.vpnAddrs[0] ?? '', h]));
		const infra = new Set([...overlay.lighthouses, ...overlay.relays].map(h => h.vpnIP));
		const revoked = cert ? isRevoked(await this.revocations(networkID, overlay), cert) : false;
		// A member whose certificate is revoked, expired or about to end asks again; its new request is shown like a first one.
		const request = !cert || revoked || Date.parse(cert.notAfter) - Date.now() <= MEMBER_RENEWAL_WINDOW_MS ? await store.readRequest() : null;
		const ownIP = cert?.networks[0]?.split('/')[0];
		const invite = request ? await store.readJSON<InviteFile>('invite.json').catch(() => null) : null;
		const inviteState: OverlayInviteState = invite && Date.parse(invite.expires) <= Date.now() ? 'expired' : (this.inviteStates.get(networkID) ?? 'delivering');
		const refused = request ? (await store.readJSON<RenewalRefusal>('refusal.json').catch(() => null))?.requestCreated === request.created : false;
		const last = request ? null : await store.readJSON<OverlayAccessRequest>('last-request.json').catch(() => null);
		return {
			networkID,
			role: store.has('ca.key') ? 'founder' : cert ? 'member' : 'none',
			...(cert ? { certificate: { name: cert.name, vpnIP: cert.networks[0]!.split('/')[0]!, groups: cert.groups, notBefore: cert.notBefore, notAfter: cert.notAfter, fingerprint: cert.fingerprint, revoked } } : {}),
			...(request ? { request } : {}),
			...(invite ? { invite: { expires: invite.expires, state: inviteState } } : {}),
			...(refused ? { renewalRefused: true } : {}),
			...(last ? { lastRequest: { name: last.name, ...(last.infraAddr !== undefined ? { infraAddr: last.infraAddr } : {}) } } : {}),
			running: nodes.isRunning(networkID),
			stateVersion: state?.version ?? overlay.version,
			hosts: [...overlay.lighthouses.map(h => ({ ...h, role: 'lighthouse' as const })), ...overlay.relays.map(h => ({ ...h, role: 'relay' as const }))].map(h => (h.vpnIP === ownIP ? { ...h, connected: true, self: true } : { ...h, connected: tunnels.has(h.vpnIP) })),
			peers: [...tunnels.values()].filter(h => !infra.has(h.vpnAddrs[0] ?? '')).map(h => ({ vpnIP: h.vpnAddrs[0] ?? '', name: h.name, path: h.relayedVia.length > 0 ? 'relay' : 'direct' })),
		};
	}
}
