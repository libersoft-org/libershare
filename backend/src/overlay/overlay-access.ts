import { Mutex } from 'async-mutex';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { CodedError, ErrorCodes, isHostPort, parseSubnet, subnetAddress, validateAccessRequest, validateOverlayHosts, type LISHNetworkConfig, type LISHOverlayDefinition, type LISHOverlayHost, type OverlayAccessRequest, type OverlayCertificateBundle, type OverlayMember, type OverlayPendingRequest, type OverlayRole, type OverlayStatus } from '@shared';
import { SqliteDatastore } from '../protocol/datastore.ts';
import { PRIVATE_KEY_PATH, writeIdentityKey } from '../protocol/identity-store.ts';
import { runOverlayCommand, type CertificateInfo } from './overlay-binary.ts';
import { OVERLAY_LIBP2P_PORT } from './nebula-config.ts';
import { type OverlayNodes } from './overlay-nodes.ts';
import { type FounderData, type OverlayStore } from './overlay-store.ts';

const DEFAULT_SUBNET = '100.64.0.0/16';
const DEFAULT_MEMBER_DAYS = 365;
const MAX_PENDING_REQUESTS = 1000;
const ROLES: readonly OverlayRole[] = ['lighthouse', 'relay'];
const FINGERPRINT = /^[0-9a-f]{64}$/;

export interface OverlayAccessDeps {
	nodes: OverlayNodes;
	getRow(networkID: string): LISHNetworkConfig | undefined;
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

	constructor(deps: OverlayAccessDeps) {
		this.deps = deps;
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

	private async issueCertificate(store: OverlayStore, request: { publicKey: string; peerID: string }, vpnIP: string, bits: number, groups: string[], notAfter: string): Promise<CertificateInfo> {
		await store.remove('issue.crt');
		await store.writeText('issue.pub', request.publicKey);
		try {
			return await runOverlayCommand<CertificateInfo>(['sign', '--ca-crt', store.path('ca.crt'), '--ca-key', store.path('ca.key'), '--public-key', store.path('issue.pub'), '--name', request.peerID, '--ip', `${vpnIP}/${bits}`, '--groups', groups.join(','), '--not-after', notAfter, '--out-crt', store.path('issue.crt')]);
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
			const founder: FounderData = { nextHost: 2, members: [{ name, founder: true, peerID, vpnIP, roles, notAfter: cert.notAfter, fingerprint: cert.fingerprint, issued: new Date().toISOString(), revoked: false }], requests: [] };
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
		const request = validateAccessRequest({ type: 'lish-overlay-request', networkID, name, peerID: await this.nodePeerID(networkID, store), publicKey: await this.memberKey(store), ...(infraAddr !== undefined ? { infraAddr } : {}), created: new Date().toISOString() });
		await store.writeJSON('request.json', request);
		this.deps.emit('overlay:status', { networkID });
		return request;
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
			const kept = data.requests.filter(r => r.id !== requestID);
			if (kept.length === data.requests.length) return false;
			data.requests = kept;
			await store.writeJSON('founder.json', data);
			return true;
		});
		if (removed) this.deps.emit('overlay:members', { networkID });
		return removed;
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
		const { bundleMember, request, hadRoles, superseded } = await this.founderLock(networkID).runExclusive(async () => {
			const data = await store.readFounder();
			const request = data.requests.find(r => r.id === requestID);
			if (!request) throw new CodedError(ErrorCodes.OVERLAY_REQUEST_NOT_FOUND, requestID);
			if (roles.length > 0 && !request.infraAddr) throw new CodedError(ErrorCodes.NETWORK_INVALID, 'an infrastructure role needs the public address the request offers');
			const subnet = parseSubnet(overlay.subnet)!;
			// A renewal keeps the address the member already had; a new member gets the next free one.
			const current = data.members.filter(m => m.peerID === request.peerID && !m.revoked);
			const previous = current[0];
			let vpnIP = previous?.vpnIP;
			if (!vpnIP) {
				const used = new Set(data.members.map(m => m.vpnIP));
				while (data.nextHost < subnet.size - 1 && used.has(subnetAddress(overlay.subnet, data.nextHost))) data.nextHost++;
				if (data.nextHost >= subnet.size - 1) throw new CodedError(ErrorCodes.OVERLAY_ADDRESSES_EXHAUSTED, overlay.subnet);
				vpnIP = subnetAddress(overlay.subnet, data.nextHost++);
			}
			const cert = await this.issueCertificate(store, request, vpnIP, subnet.bits, ['member', ...roles], until.toISOString().replace(/\.\d{3}Z$/, 'Z'));
			// A renewal that ends sooner than a certificate the node still holds would shorten nothing while that
			// one stays valid: it is revoked, and the node is out until it imports the new one.
			const superseded = current.filter(m => Date.parse(m.notAfter) > Date.parse(cert.notAfter));
			for (const m of superseded) m.revoked = true;
			const member: OverlayMember = { name: request.name, peerID: request.peerID, vpnIP, roles, notAfter: cert.notAfter, fingerprint: cert.fingerprint, issued: new Date().toISOString(), revoked: false };
			data.members.push(member);
			data.requests = data.requests.filter(r => r.id !== requestID);
			await store.writeJSON('founder.json', data);
			return { bundleMember: { member, cert: cert.cert }, request, hadRoles: current.some(m => m.roles.length > 0), superseded: superseded.map(m => m.fingerprint) };
		});
		// Roles given, taken away by a renewal without them, or an older certificate to revoke: a new signed state.
		if (roles.length > 0 || hadRoles || superseded.length > 0) {
			const host: LISHOverlayHost = { vpnIP: bundleMember.member.vpnIP, addr: request.infraAddr ?? '', peerID: request.peerID };
			const current = await this.deps.nodes.currentState(networkID, overlay);
			const others = (list: LISHOverlayHost[]): LISHOverlayHost[] => list.filter(h => h.vpnIP !== host.vpnIP);
			await this.deps.nodes.publishNewState(networkID, {
				lighthouses: roles.includes('lighthouse') ? [...others(overlay.lighthouses), host] : others(overlay.lighthouses),
				relays: roles.includes('relay') ? [...others(overlay.relays), host] : others(overlay.relays),
				revoked: [...new Set([...(current?.revoked ?? []), ...superseded])],
			});
		}
		this.deps.emit('overlay:members', { networkID });
		const state = await store.readState();
		return { type: 'lish-overlay-certificate', networkID, certificate: bundleMember.cert, ...(state ? { state } : {}) };
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
		const { member, fingerprints } = await this.founderLock(networkID).runExclusive(async () => {
			const data = await store.readFounder();
			const member = data.members.find(m => m.fingerprint === fingerprint);
			if (own && (own.fingerprint === fingerprint || member?.peerID === own.name)) throw new CodedError(ErrorCodes.NETWORK_INVALID, "the founder's own certificate cannot be revoked");
			const node = member ? data.members.filter(m => m.peerID === member.peerID && !m.revoked) : [];
			for (const m of node) m.revoked = true;
			if (node.length > 0) await store.writeJSON('founder.json', data);
			return { member, fingerprints: [fingerprint, ...node.map(m => m.fingerprint)] };
		});
		const current = await this.deps.nodes.currentState(networkID, overlay);
		const keep = (list: LISHOverlayHost[]): LISHOverlayHost[] => (member ? list.filter(h => h.vpnIP !== member.vpnIP || h.peerID !== member.peerID) : list);
		await this.deps.nodes.publishNewState(networkID, { lighthouses: keep(overlay.lighthouses), relays: keep(overlay.relays), revoked: [...new Set([...(current?.revoked ?? []), ...fingerprints])] });
		this.deps.emit('overlay:members', { networkID });
	}

	/** Founder: replace the lishnet's lighthouses and relays. */
	async setHosts(networkID: string, lighthouses: unknown, relays: unknown): Promise<void> {
		const { overlay } = this.founderOf(networkID);
		const lh = validateOverlayHosts(lighthouses, overlay.subnet, 'lighthouses');
		const rl = validateOverlayHosts(relays, overlay.subnet, 'relays');
		const current = await this.deps.nodes.currentState(networkID, overlay);
		await this.deps.nodes.publishNewState(networkID, { lighthouses: lh, relays: rl, revoked: current?.revoked ?? [] });
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
			await store.remove('request.json');
		} finally {
			await store.remove('issue.crt');
		}
		await this.deps.refresh(bundle.networkID);
		this.deps.emit('overlay:status', { networkID: bundle.networkID });
		return await this.status(bundle.networkID);
	}

	/** Founder: the CA key, for a backup or a second device that should be able to approve and revoke as well. */
	async exportCA(networkID: string): Promise<{ networkID: string; caKey: string }> {
		const { store } = this.founderOf(networkID);
		return { networkID, caKey: (await store.readText('ca.key'))! };
	}

	/** Restore the CA key from a backup. It must belong to the lishnet's CA certificate. */
	async importCA(networkID: string, caKey: string): Promise<void> {
		const { overlay, store } = this.overlayOf(networkID);
		const body = /-----BEGIN NEBULA ED25519 PRIVATE KEY-----([\s\S]*?)-----END NEBULA ED25519 PRIVATE KEY-----/.exec(caKey ?? '')?.[1];
		const raw = body ? Buffer.from(body.replace(/\s+/g, ''), 'base64') : Buffer.alloc(0);
		if (raw.length !== 64) throw new CodedError(ErrorCodes.OVERLAY_CERTIFICATE_INVALID, 'not a CA key');
		if (raw.subarray(32).toString('hex') !== (await this.deps.nodes.caPublicKey(store, overlay.caCert))) throw new CodedError(ErrorCodes.OVERLAY_CERTIFICATE_INVALID, 'the key does not belong to this lishnet');
		await store.writeText('ca.key', caKey.trim() + '\n');
		if (!store.has('founder.json')) await store.writeJSON('founder.json', await store.readFounder());
		this.deps.emit('overlay:status', { networkID });
	}

	async status(networkID: string): Promise<OverlayStatus> {
		const { overlay, store } = this.overlayOf(networkID);
		const nodes = this.deps.nodes;
		const cert = await nodes.ownCertificate(store, overlay.caCert).catch(() => null);
		const state = await nodes.currentState(networkID, overlay);
		const helper = await nodes.helperStatus(networkID);
		const tunnels = new Map((helper?.hosts ?? []).map(h => [h.vpnAddrs[0] ?? '', h]));
		const infra = new Set([...overlay.lighthouses, ...overlay.relays].map(h => h.vpnIP));
		const request = cert ? null : await store.readRequest();
		const ownIP = cert?.networks[0]?.split('/')[0];
		return {
			networkID,
			role: store.has('ca.key') ? 'founder' : cert ? 'member' : 'none',
			...(cert ? { certificate: { name: cert.name, vpnIP: cert.networks[0]!.split('/')[0]!, groups: cert.groups, notBefore: cert.notBefore, notAfter: cert.notAfter, fingerprint: cert.fingerprint, revoked: state?.revoked.includes(cert.fingerprint) ?? false } } : {}),
			...(request ? { request } : {}),
			running: nodes.isRunning(networkID),
			stateVersion: state?.version ?? overlay.version,
			hosts: [...overlay.lighthouses.map(h => ({ ...h, role: 'lighthouse' as const })), ...overlay.relays.map(h => ({ ...h, role: 'relay' as const }))].map(h => (h.vpnIP === ownIP ? { ...h, connected: true, self: true } : { ...h, connected: tunnels.has(h.vpnIP) })),
			peers: [...tunnels.values()].filter(h => !infra.has(h.vpnAddrs[0] ?? '')).map(h => ({ vpnIP: h.vpnAddrs[0] ?? '', name: h.name, path: h.relayedVia.length > 0 ? 'relay' : 'direct' })),
		};
	}
}
