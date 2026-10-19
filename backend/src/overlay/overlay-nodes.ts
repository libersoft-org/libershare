import { Mutex } from 'async-mutex';
import * as dns from 'node:dns/promises';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isRevoked, mergeRevocations, type BootstrapStatus, type LISHNetworkConfig, type LISHOverlayDefinition, type OverlayRevocations, type OverlayState, type SignedOverlayState } from '@shared';
import { Network } from '../protocol/network.ts';
import { type DataServer } from '../lish/data-server.ts';
import { type Settings } from '../settings.ts';
import { type OverlayBridge } from '../protocol/overlay-transport.ts';
import { OverlayHelper, type HelperStatus } from './overlay-helper.ts';
import { OverlayStore } from './overlay-store.ts';
import { runOverlayCommand, type CertificateInfo } from './overlay-binary.ts';
import { buildNebulaConfig, infraHosts, OVERLAY_LIBP2P_PORT, startOnlySettings } from './nebula-config.ts';
import { applyState, nextVersion, signState, verifyState } from './overlay-state.ts';

/** Every node republishes the newest state it holds this often, so late joiners and missed messages catch up. */
const STATE_REPUBLISH_MS = 60_000;
/** A peer joining the state topic triggers a publish, at most this often. */
const STATE_PUBLISH_MIN_GAP_MS = 5_000;
/** A new revocation is passed on this long before the node blocks the revoked certificate. */
const REVOCATION_NOTICE_MS = 1_000;
const RESTART_DELAY_MIN_MS = 1_000;
const RESTART_DELAY_MAX_MS = 30_000;

/** Whether two sets of revocations hold the same fingerprints and the same revoked members at the same times. */
function sameRevocations(a: OverlayRevocations, b: OverlayRevocations): boolean {
	const fingerprints = new Set(a.fingerprints);
	if (fingerprints.size !== new Set(b.fingerprints).size || b.fingerprints.some(f => !fingerprints.has(f))) return false;
	const peers = Object.keys(a.peers);
	return peers.length === Object.keys(b.peers).length && peers.every(p => b.peers[p] === a.peers[p]);
}

export function stateTopic(networkID: string): string {
	return `lish-overlay-state/${networkID}`;
}

export interface OverlayNodesDeps {
	dataDir: string;
	dataServer: DataServer;
	settings: Settings;
	getRow(networkID: string): LISHNetworkConfig | undefined;
	/** Store a newer overlay definition (hosts from a verified state) in the lishnet's row. */
	saveOverlay(networkID: string, overlay: LISHOverlayDefinition): void;
	onPeerCountChange(): void;
	onBootstrapStatusChange(networkID: string, status: BootstrapStatus): void;
	/** A newer signed state was accepted. */
	onStateChange(networkID: string, state: OverlayState): void;
	/** The lishnet's node was restarted as a new {@link Network} (new address, role or port) and is running again. */
	onNodeReplaced?(networkID: string): void;
}

interface RunningOverlay {
	networkID: string;
	store: OverlayStore;
	vpnIP: string;
	peerID: string;
	helper: OverlayHelper;
	network: Network;
	/** Loopback port of the node's listener, re-registered with a restarted helper. */
	inboundPort: number;
	stopped: boolean;
	restartDelay: number;
	restartTimer: ReturnType<typeof setTimeout> | null;
	republishTimer: ReturnType<typeof setInterval>;
	lastPublish: number;
	disposeSubscribe: () => void;
	/** {@link startOnlySettings} the helper was started with. */
	startOnly: string;
	/** The last reconfiguration failed: the helper may still run without a newer revocation, so it is retried. */
	unapplied: boolean;
	/** The infrastructure addresses the written configuration allows ({@link OverlayNodes.followInfraAddresses}). */
	infraIPs: string[];
	/** The same per host name, the last ones each name resolved to. */
	infraByHost: Map<string, string[]>;
}

/**
 * The runtime of the protected lishnets this node has joined: per lishnet a `lish-overlay` helper (its Nebula
 * node) and a libp2p {@link Network} whose only transport is that helper's bridge. The node has its own
 * identity (`<dataDir>/lishnet-nodes/<id>/datastore`), so nothing ties it to the public node's peer ID.
 */
export class OverlayNodes {
	private readonly deps: OverlayNodesDeps;
	private readonly running = new Map<string, RunningOverlay>();
	private readonly locks = new Map<string, Mutex>();
	private readonly caKeys = new Map<string, string>();

	constructor(deps: OverlayNodesDeps) {
		this.deps = deps;
	}

	private lock(networkID: string): Mutex {
		let lock = this.locks.get(networkID);
		if (!lock) this.locks.set(networkID, (lock = new Mutex()));
		return lock;
	}

	store(networkID: string): OverlayStore {
		return new OverlayStore(this.deps.dataDir, networkID);
	}

	network(networkID: string): Network | undefined {
		return this.running.get(networkID)?.network;
	}

	isRunning(networkID: string): boolean {
		return this.running.has(networkID);
	}

	runningIDs(): string[] {
		return [...this.running.keys()];
	}

	async helperStatus(networkID: string): Promise<HelperStatus | null> {
		const entry = this.running.get(networkID);
		if (!entry || !entry.helper.isRunning()) return null;
		return await entry.helper.status().catch(() => null);
	}

	/** Public key (hex) of a lishnet's CA, read from its certificate by the helper once per certificate. */
	async caPublicKey(store: OverlayStore, caCert: string): Promise<string> {
		// The file is written even when the key is cached: signing and verifying read it, and a lishnet deleted and
		// added again in the same run has lost it.
		if ((await store.readText('ca.crt')) !== caCert) {
			await store.ensureDir();
			await store.writeText('ca.crt', caCert);
		}
		const cached = this.caKeys.get(caCert);
		if (cached) return cached;
		const info = await runOverlayCommand<CertificateInfo>(['print', '--crt', store.path('ca.crt')]);
		if (!info.isCA) throw new Error('the lishnet CA certificate is not a CA');
		this.caKeys.set(caCert, info.publicKey);
		return info.publicKey;
	}

	/** This node's certificate, checked against the lishnet's CA. */
	async ownCertificate(store: OverlayStore, caCert: string): Promise<CertificateInfo | null> {
		if (!store.has('member.crt')) return null;
		await this.caPublicKey(store, caCert);
		return await runOverlayCommand<CertificateInfo>(['print', '--crt', store.path('member.crt'), '--ca', store.path('ca.crt')]);
	}

	/** The newest verified state of a lishnet, or null. */
	async currentState(networkID: string, overlay: LISHOverlayDefinition): Promise<OverlayState | null> {
		const store = this.store(networkID);
		const signed = await store.readState();
		if (!signed) return null;
		try {
			return await verifyState(signed, await this.caPublicKey(store, overlay.caCert), networkID, overlay.subnet);
		} catch (err: any) {
			console.error(`[Overlay ${networkID.slice(0, 8)}] stored state does not verify, ignoring it: ${err?.message ?? err}`);
			return null;
		}
	}

	/**
	 * The underlay addresses of the lishnet's lighthouses and relays, per host name and all of them sorted. A name
	 * that does not resolve right now keeps the addresses it had (`known`): dropping them would cut the member off
	 * over a passing DNS failure, and holding back the others would keep a moved host locked out.
	 */
	private async resolveInfra(networkID: string, overlay: LISHOverlayDefinition, known: Map<string, string[]>): Promise<{ byHost: Map<string, string[]>; ips: string[] }> {
		const byHost = new Map<string, string[]>();
		for (const host of infraHosts(overlay)) {
			try {
				byHost.set(host, [...new Set((await dns.lookup(host, { all: true, family: 4 })).map(r => r.address))].sort());
			} catch (err: any) {
				const last = known.get(host);
				if (last) byHost.set(host, last);
				console.warn(`[Overlay ${networkID.slice(0, 8)}] cannot resolve ${host}${last ? ', keeping its last addresses' : ''}: ${err?.message ?? err}`);
			}
		}
		return { byHost, ips: [...new Set([...byHost.values()].flat())].sort() };
	}

	/**
	 * Every revocation this node knows: the current signed state, every one it accepted before (a newer state that
	 * lacks one does not lift it), and on a founder's node the member list and the revocations of a restored backup.
	 */
	async knownRevocations(networkID: string, overlay: LISHOverlayDefinition): Promise<OverlayRevocations> {
		const store = this.store(networkID);
		const state = await this.currentState(networkID, overlay);
		let known = mergeRevocations(await store.readRevocations(), { fingerprints: state?.revoked ?? [], peers: state?.revokedPeers ?? {} });
		if (store.has('founder.json')) {
			const founder = await store.readFounder();
			known = mergeRevocations(known, { fingerprints: [...founder.members.filter(m => m.revoked).map(m => m.fingerprint), ...(founder.revoked ?? [])], peers: founder.revokedPeers ?? {} });
		}
		return known;
	}

	/**
	 * Whether a libp2p connection over the lishnet's overlay may stand: the tunnel it came through must exist, carry a
	 * certificate named after the peer ID the connection proved (so no member speaks for another), and that certificate
	 * must not be revoked, by fingerprint or as a revoked member's. A revoked one also goes onto Nebula's blocklist.
	 */
	async authorizePeer(networkID: string, peerID: string, overlayIP: string): Promise<boolean> {
		const entry = this.running.get(networkID);
		const row = this.deps.getRow(networkID);
		if (!entry || !row?.overlay || !entry.helper.isRunning()) return false;
		const host = (await entry.helper.status().catch(() => null))?.hosts.find(h => h.vpnAddrs.includes(overlayIP));
		const tag = `[Overlay ${networkID.slice(0, 8)}]`;
		if (!host) {
			console.warn(`${tag} refused ${peerID.slice(0, 12)}: no tunnel to ${overlayIP}`);
			return false;
		}
		if (host.name !== peerID) {
			console.warn(`${tag} refused ${peerID.slice(0, 12)} at ${overlayIP}: the certificate there names ${host.name.slice(0, 12)}`);
			return false;
		}
		if (isRevoked(await this.knownRevocations(networkID, row.overlay), host)) {
			console.warn(`${tag} refused ${peerID.slice(0, 12)}: its certificate is revoked`);
			void this.sweepRevokedPeers(networkID).catch(() => {});
			return false;
		}
		return true;
	}

	/**
	 * Certificates of revoked members found on this node's tunnels go onto Nebula's blocklist: a member revoked by peer
	 * ID may hold one issued by another device holding the CA key, whose fingerprint no state lists.
	 */
	async sweepRevokedPeers(networkID: string): Promise<void> {
		const entry = this.running.get(networkID);
		const row = this.deps.getRow(networkID);
		if (!entry || !row?.overlay || !entry.helper.isRunning()) return;
		const known = await this.knownRevocations(networkID, row.overlay);
		const found = ((await entry.helper.status().catch(() => null))?.hosts ?? []).filter(h => h.fingerprint && !known.fingerprints.includes(h.fingerprint) && isRevoked(known, h)).map(h => h.fingerprint);
		if (found.length === 0) return;
		await this.lock(networkID).runExclusive(async () => {
			await entry.store.writeJSON('revoked.json', mergeRevocations(await entry.store.readRevocations(), { fingerprints: found, peers: {} }));
		});
		console.log(`[Overlay ${networkID.slice(0, 8)}] blocking ${found.length} certificate(s) of revoked members`);
		await this.reconfigure(networkID);
	}

	/** Write the Nebula configuration; returns the infrastructure addresses it allows. */
	private async writeConfig(entry: { networkID: string; store: OverlayStore; vpnIP: string; peerID: string }, overlay: LISHOverlayDefinition, known: Map<string, string[]>): Promise<{ byHost: Map<string, string[]>; ips: string[] }> {
		const resolved = await this.resolveInfra(entry.networkID, overlay, known);
		const { ips } = resolved;
		const config = buildNebulaConfig({
			pki: { ca: entry.store.path('ca.crt'), cert: entry.store.path('member.crt'), key: entry.store.path('member.key') },
			overlay,
			vpnIP: entry.vpnIP,
			peerID: entry.peerID,
			revoked: (await this.knownRevocations(entry.networkID, overlay)).fingerprints,
			infraIPs: ips,
		});
		await entry.store.writeJSON('nebula.yml', config);
		return resolved;
	}

	/**
	 * A lighthouse or relay given by name can move to another address; the allow list of a member names addresses, so
	 * it has to follow, or every packet from the new one is dropped.
	 */
	private async followInfraAddresses(networkID: string): Promise<void> {
		const entry = this.running.get(networkID);
		const row = this.deps.getRow(networkID);
		if (!entry || !row?.overlay) return;
		const { ips, byHost } = await this.resolveInfra(networkID, row.overlay, entry.infraByHost);
		// Kept even when the whole set did not change (two names that swapped addresses): a later failed lookup falls
		// back to what each name resolved to last, not to an older pairing.
		entry.infraByHost = byHost;
		if (ips.join(',') !== entry.infraIPs.join(',')) await this.reconfigure(networkID);
	}

	/** libp2p bootstrap addresses: the definition's own list plus every host that names its peer ID. */
	private bootstrapPeers(row: LISHNetworkConfig, overlay: LISHOverlayDefinition, self: string): string[] {
		const fromHosts = [...overlay.lighthouses, ...overlay.relays].filter(h => h.peerID && h.peerID !== self).map(h => `/ip4/${h.vpnIP}/tcp/${OVERLAY_LIBP2P_PORT}/p2p/${h.peerID}`);
		return [...new Set([...row.bootstrapPeers, ...fromHosts])];
	}

	/**
	 * Start the lishnet's helper and node and subscribe its topic. Returns false (and starts nothing) while this
	 * node has no certificate for the lishnet yet.
	 */
	async join(row: LISHNetworkConfig): Promise<boolean> {
		const overlay = row.overlay;
		if (!overlay) throw new Error(`${row.networkID} is not a protected lishnet`);
		return await this.lock(row.networkID).runExclusive(async () => {
			if (this.running.has(row.networkID)) return true;
			const store = this.store(row.networkID);
			const cert = await this.ownCertificate(store, overlay.caCert);
			if (!cert || !store.has('member.key')) {
				console.log(`[Overlay ${row.networkID.slice(0, 8)}] not joining ${row.name}: no certificate for this lishnet yet`);
				return false;
			}
			const vpnIP = cert.networks[0]!.split('/')[0]!;
			const base = { networkID: row.networkID, store, vpnIP, peerID: cert.name };
			const infra = await this.writeConfig(base, overlay, new Map());
			const entry = { ...base, inboundPort: 0, stopped: false, restartDelay: RESTART_DELAY_MIN_MS, restartTimer: null, lastPublish: 0, startOnly: startOnlySettings(overlay, vpnIP), unapplied: false, infraIPs: infra.ips, infraByHost: infra.byHost } as RunningOverlay;
			entry.helper = await this.startHelper(entry);
			const bridge: OverlayBridge = {
				get dialPort() {
					return entry.helper.dialPort;
				},
				get token() {
					return entry.helper.token;
				},
				subnet: overlay.subnet,
				setInboundPort: async port => {
					entry.inboundPort = port;
					await entry.helper.setInboundPort(port);
				},
			};
			entry.network = new Network(store.dir, this.deps.dataServer, this.deps.settings, { overlay: { vpnIP, port: OVERLAY_LIBP2P_PORT, bridge, authorize: (peerID, overlayIP) => this.authorizePeer(row.networkID, peerID, overlayIP) }, lishScope: row.networkID });
			entry.network.onPeerCountChange = () => this.deps.onPeerCountChange();
			entry.network.onBootstrapStatusChange = (id, status) => this.deps.onBootstrapStatusChange(id, status);
			try {
				await entry.network.start([]);
				const node = entry.network.getNodeInfo();
				if (node && node.peerID !== cert.name) console.warn(`[Overlay ${row.networkID.slice(0, 8)}] node identity ${node.peerID} differs from the certificate name ${cert.name}`);
				if (!entry.network.subscribeTopic(row.networkID)) throw new Error('could not subscribe the lishnet topic');
				await entry.network.subscribe(stateTopic(row.networkID), message => void this.onStateMessage(row.networkID, message));
			} catch (err) {
				// A helper that died meanwhile has a restart scheduled, for an entry nothing would ever stop.
				entry.stopped = true;
				if (entry.restartTimer) clearTimeout(entry.restartTimer);
				await entry.network.stop().catch(() => {});
				await entry.helper.stop();
				throw err;
			}
			entry.disposeSubscribe = entry.network.onPeerSubscribe((_peer, topic) => {
				if (topic === stateTopic(row.networkID)) void this.publishState(row.networkID, false);
			});
			entry.republishTimer = setInterval(() => {
				void this.publishState(row.networkID, true);
				const applied = entry.unapplied ? this.reconfigure(row.networkID) : this.followInfraAddresses(row.networkID).then(() => this.sweepRevokedPeers(row.networkID));
				void applied.catch(err => console.error(`[Overlay ${row.networkID.slice(0, 8)}] reconfiguration failed: ${err?.message ?? err}`));
			}, STATE_REPUBLISH_MS);
			this.running.set(row.networkID, entry);
			const bootstrap = this.bootstrapPeers(row, overlay, cert.name);
			if (bootstrap.length > 0) void entry.network.addBootstrapPeers(bootstrap, row.networkID, 'configured').catch(err => console.error(`[Overlay ${row.networkID.slice(0, 8)}] bootstrap failed: ${err?.message ?? err}`));
			console.log(`✓ Joined protected lishnet ${row.name} as ${vpnIP}`);
			return true;
		});
	}

	private startHelper(entry: RunningOverlay): Promise<OverlayHelper> {
		return OverlayHelper.start({ configPath: entry.store.path('nebula.yml'), port: OVERLAY_LIBP2P_PORT, tag: entry.networkID.slice(0, 8), onExit: () => this.scheduleRestart(entry) });
	}

	/**
	 * A helper that died takes every tunnel of the lishnet with it; the libp2p node keeps running and redials
	 * once a new helper is up. Restarts back off from 1 s to 30 s, and a helper that stays up resets the delay.
	 */
	private scheduleRestart(entry: RunningOverlay): void {
		if (entry.stopped || entry.restartTimer) return;
		const delay = entry.restartDelay;
		entry.restartDelay = Math.min(delay * 2, RESTART_DELAY_MAX_MS);
		console.warn(`[Overlay ${entry.networkID.slice(0, 8)}] restarting the helper in ${delay / 1000}s`);
		entry.restartTimer = setTimeout(() => {
			entry.restartTimer = null;
			void this.lock(entry.networkID).runExclusive(async () => {
				if (entry.stopped) return;
				try {
					entry.helper = await this.startHelper(entry);
					if (entry.inboundPort) await entry.helper.setInboundPort(entry.inboundPort);
					setTimeout(() => {
						if (entry.helper.isRunning()) entry.restartDelay = RESTART_DELAY_MIN_MS;
					}, RESTART_DELAY_MAX_MS);
				} catch (err: any) {
					console.error(`[Overlay ${entry.networkID.slice(0, 8)}] helper restart failed: ${err?.message ?? err}`);
					this.scheduleRestart(entry);
				}
			});
		}, delay);
	}

	/** Stop the lishnet's node and helper. */
	async leave(networkID: string): Promise<void> {
		await this.lock(networkID).runExclusive(async () => {
			const entry = this.running.get(networkID);
			if (!entry) return;
			this.running.delete(networkID);
			entry.stopped = true;
			if (entry.restartTimer) clearTimeout(entry.restartTimer);
			clearInterval(entry.republishTimer);
			entry.disposeSubscribe();
			try {
				entry.network.unsubscribeTopic(networkID);
				await entry.network.stop();
			} finally {
				await entry.helper.stop();
			}
			this.deps.onPeerCountChange();
			console.log(`✓ Left protected lishnet ${networkID}`);
		});
		if (!this.running.has(networkID) && !this.lock(networkID).isLocked()) this.locks.delete(networkID);
	}

	/** A deleted lishnet: stop it if it still runs and delete its keys, certificate and node data. */
	async removeData(networkID: string): Promise<void> {
		await this.leave(networkID);
		let store: OverlayStore;
		try {
			store = this.store(networkID);
		} catch {
			return; // an ID that cannot be a directory name never had overlay data
		}
		await store.removeAll();
	}

	/** Factory reset of the lishnets: every protected lishnet's keys, certificates and node data. Nodes must be stopped. */
	async removeAllData(): Promise<void> {
		if (this.running.size > 0) throw new Error('protected lishnets are still running');
		await rm(join(this.deps.dataDir, 'lishnet-nodes'), { recursive: true, force: true });
	}

	async stopAll(): Promise<void> {
		const failures: unknown[] = [];
		for (const id of this.runningIDs()) await this.leave(id).catch(err => failures.push(err));
		if (failures.length > 0) throw new AggregateError(failures, `${failures.length} protected lishnet(s) could not be stopped`);
	}

	/**
	 * Re-read the lishnet's row and apply it to a running node: new hosts, revocations and a renewed certificate, no
	 * restart. A certificate for another overlay address (a member approved again after a revocation) restarts the
	 * helper and the node: Nebula keeps the old certificate on reload, and the node listens on the old address. So
	 * does a new lighthouse role or listen port of this node ({@link startOnlySettings}).
	 */
	async reconfigure(networkID: string): Promise<void> {
		const entry = this.running.get(networkID);
		const row = this.deps.getRow(networkID);
		if (entry && row?.overlay) {
			const cert = await this.ownCertificate(entry.store, row.overlay.caCert);
			if ((cert && cert.networks[0]!.split('/')[0] !== entry.vpnIP) || startOnlySettings(row.overlay, entry.vpnIP) !== entry.startOnly) {
				await this.leave(networkID);
				if (await this.join(row)) this.deps.onNodeReplaced?.(networkID);
				return;
			}
		}
		await this.lock(networkID).runExclusive(async () => {
			const entry = this.running.get(networkID);
			const row = this.deps.getRow(networkID);
			if (!entry || !row?.overlay) return;
			try {
				const infra = await this.writeConfig(entry, row.overlay, entry.infraByHost);
				entry.infraIPs = infra.ips;
				entry.infraByHost = infra.byHost;
				if (entry.helper.isRunning()) await entry.helper.reload();
				entry.unapplied = false;
			} catch (err) {
				entry.unapplied = true;
				throw err;
			}
			const bootstrap = this.bootstrapPeers(row, row.overlay, entry.peerID);
			if (bootstrap.length > 0) void entry.network.addBootstrapPeers(bootstrap, networkID, 'configured').catch(() => {});
		});
	}

	private async onStateMessage(networkID: string, message: any): Promise<void> {
		if (message?.type !== 'overlayState') return;
		await this.acceptState(networkID, message.signed).catch(err => console.warn(`[Overlay ${networkID.slice(0, 8)}] rejected a state: ${err?.message ?? err}`));
	}

	/**
	 * Take a signed state from anywhere — a peer, a certificate bundle, the founder's own change. It is verified
	 * against the CA in the lishnet's definition; only a higher version than the one held replaces it. Returns
	 * whether it did.
	 *
	 * On the founder's node (CA key present) revocations are never lost to a concurrent change from another device
	 * holding the CA: a state that misses some of ours, or carries some we lack, is answered with a merged one.
	 */
	async acceptState(networkID: string, signed: SignedOverlayState): Promise<boolean> {
		const row = this.deps.getRow(networkID);
		if (!row?.overlay) return false;
		const overlay = row.overlay;
		const store = this.store(networkID);
		const incoming = await verifyState(signed, await this.caPublicKey(store, overlay.caCert), networkID, overlay.subnet);
		const { changed, previous, revokes } = await this.lock(networkID).runExclusive(async () => {
			// Every verified state adds its revocations, whatever its version: a newer one that lacks one (signed on a
			// device restored from an older backup) does not lift it.
			const before = await store.readRevocations();
			const after = mergeRevocations(before, { fingerprints: incoming.revoked, peers: incoming.revokedPeers ?? {} });
			const revokes = !sameRevocations(before, after);
			if (revokes) await store.writeJSON('revoked.json', after);
			const previous = await this.currentState(networkID, overlay);
			if (previous && incoming.version <= previous.version) return { changed: false, previous, revokes };
			await store.writeJSON('state.json', signed);
			this.deps.saveOverlay(networkID, applyState(overlay, incoming));
			return { changed: true, previous, revokes };
		});
		const held = changed ? incoming : previous!;
		if (store.has('ca.key')) {
			// The founder answers a state that misses revocations it knows with one that has them all.
			const known = await this.knownRevocations(networkID, overlay);
			if (!sameRevocations(mergeRevocations({ fingerprints: held.revoked, peers: held.revokedPeers ?? {} }, known), { fingerprints: held.revoked, peers: held.revokedPeers ?? {} })) {
				await this.publishNewState(networkID, { lighthouses: held.lighthouses, relays: held.relays, revoked: known.fingerprints, revokedPeers: known.peers });
				return true;
			}
		}
		if (!changed) {
			// The sender is behind; our newer state reaches it through the topic.
			if (incoming.version < held.version) void this.publishState(networkID, false);
			// Stored but never applied (writing the configuration or the reload failed), or an older state that still
			// carried a revocation this node lacked: this copy is the chance to apply it.
			if (revokes || this.running.get(networkID)?.unapplied) await this.reconfigure(networkID);
			return false;
		}
		console.log(`[Overlay ${networkID.slice(0, 8)}] accepted network state v${incoming.version} (${incoming.lighthouses.length} lighthouse(s), ${incoming.relays.length} relay(s), ${incoming.revoked.length} revoked)`);
		this.deps.onStateChange(networkID, incoming);
		// Passed on at once and past the rate limit: a revocation must not wait for the next periodic send.
		await this.publishState(networkID, true);
		// This message is the only way a revoked member learns why its tunnels went, and every node cuts it off once
		// configured: give it time to get there first.
		if (revokes) await Bun.sleep(REVOCATION_NOTICE_MS);
		await this.reconfigure(networkID);
		if (revokes) await this.sweepRevokedPeers(networkID);
		return true;
	}

	/** Founder only: sign a changed state with the CA key, adopt it and publish it. */
	async publishNewState(networkID: string, change: Omit<OverlayState, 'version' | 'networkID'> & { version?: number }): Promise<OverlayState> {
		const row = this.deps.getRow(networkID);
		if (!row?.overlay) throw new Error(`${networkID} is not a protected lishnet`);
		const store = this.store(networkID);
		const caKey = await store.readText('ca.key');
		if (!caKey) throw new Error('only the founder can sign the network state');
		const current = await this.currentState(networkID, row.overlay);
		const peers = change.revokedPeers ?? {};
		const state: OverlayState = { networkID, version: nextVersion(Math.max(current?.version ?? 0, row.overlay.version)), lighthouses: change.lighthouses, relays: change.relays, revoked: change.revoked, ...(Object.keys(peers).length > 0 ? { revokedPeers: peers } : {}) };
		const signed = await signState(state, caKey);
		if (!(await this.acceptState(networkID, signed))) throw new Error('the new network state was not accepted');
		return state;
	}

	/**
	 * Publish the newest state on the lishnet's state topic. Sends triggered by peers (a subscription, a stale state)
	 * are rate limited; `force` (a new state, the periodic send) is not.
	 */
	async publishState(networkID: string, force: boolean): Promise<void> {
		const entry = this.running.get(networkID);
		if (!entry) return;
		const now = Date.now();
		if (!force && now - entry.lastPublish < STATE_PUBLISH_MIN_GAP_MS) return;
		const signed = await entry.store.readState();
		if (!signed) return;
		entry.lastPublish = now;
		await entry.network.broadcast(stateTopic(networkID), { type: 'overlayState', signed }).catch(() => {});
	}
}
