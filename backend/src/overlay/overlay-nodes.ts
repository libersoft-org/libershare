import { Mutex } from 'async-mutex';
import { lookup } from 'node:dns/promises';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type BootstrapStatus, type LISHNetworkConfig, type LISHOverlayDefinition, type OverlayState, type SignedOverlayState } from '@shared';
import { Network } from '../protocol/network.ts';
import { type DataServer } from '../lish/data-server.ts';
import { type Settings } from '../settings.ts';
import { type OverlayBridge } from '../protocol/overlay-transport.ts';
import { OverlayHelper, type HelperStatus } from './overlay-helper.ts';
import { OverlayStore } from './overlay-store.ts';
import { runOverlayCommand, type CertificateInfo } from './overlay-binary.ts';
import { buildNebulaConfig, infraHosts, OVERLAY_LIBP2P_PORT } from './nebula-config.ts';
import { applyState, nextVersion, signState, verifyState } from './overlay-state.ts';

/** Every node republishes the newest state it holds this often, so late joiners and missed messages catch up. */
const STATE_REPUBLISH_MS = 60_000;
/** A peer joining the state topic triggers a publish, at most this often. */
const STATE_PUBLISH_MIN_GAP_MS = 5_000;
const RESTART_DELAY_MIN_MS = 1_000;
const RESTART_DELAY_MAX_MS = 30_000;

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
		const cached = this.caKeys.get(caCert);
		if (cached) return cached;
		if ((await store.readText('ca.crt')) !== caCert) await store.writeText('ca.crt', caCert);
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

	private async writeConfig(entry: { networkID: string; store: OverlayStore; vpnIP: string; peerID: string }, overlay: LISHOverlayDefinition): Promise<void> {
		const state = await this.currentState(entry.networkID, overlay);
		const infraIPs: string[] = [];
		for (const host of infraHosts(overlay)) {
			try {
				for (const r of await lookup(host, { all: true, family: 4 })) infraIPs.push(r.address);
			} catch (err: any) {
				console.warn(`[Overlay ${entry.networkID.slice(0, 8)}] cannot resolve ${host}: ${err?.message ?? err}`);
			}
		}
		const config = buildNebulaConfig({
			pki: { ca: entry.store.path('ca.crt'), cert: entry.store.path('member.crt'), key: entry.store.path('member.key') },
			overlay,
			vpnIP: entry.vpnIP,
			peerID: entry.peerID,
			revoked: state?.revoked ?? [],
			infraIPs: [...new Set(infraIPs)],
		});
		await entry.store.writeJSON('nebula.yml', config);
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
			await this.writeConfig(base, overlay);
			const entry = { ...base, inboundPort: 0, stopped: false, restartDelay: RESTART_DELAY_MIN_MS, restartTimer: null, lastPublish: 0 } as RunningOverlay;
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
			entry.network = new Network(store.dir, this.deps.dataServer, this.deps.settings, { overlay: { vpnIP, port: OVERLAY_LIBP2P_PORT, bridge } });
			entry.network.onPeerCountChange = () => this.deps.onPeerCountChange();
			entry.network.onBootstrapStatusChange = (id, status) => this.deps.onBootstrapStatusChange(id, status);
			try {
				await entry.network.start([]);
				const node = entry.network.getNodeInfo();
				if (node && node.peerID !== cert.name) console.warn(`[Overlay ${row.networkID.slice(0, 8)}] node identity ${node.peerID} differs from the certificate name ${cert.name}`);
				if (!entry.network.subscribeTopic(row.networkID)) throw new Error('could not subscribe the lishnet topic');
				await entry.network.subscribe(stateTopic(row.networkID), message => void this.onStateMessage(row.networkID, message));
			} catch (err) {
				await entry.network.stop().catch(() => {});
				await entry.helper.stop();
				throw err;
			}
			entry.disposeSubscribe = entry.network.onPeerSubscribe((_peer, topic) => {
				if (topic === stateTopic(row.networkID)) void this.publishState(row.networkID, false);
			});
			entry.republishTimer = setInterval(() => void this.publishState(row.networkID, true), STATE_REPUBLISH_MS);
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

	/** Re-read the lishnet's row and apply it to a running node: new hosts and revocations, no restart. */
	async reconfigure(networkID: string): Promise<void> {
		await this.lock(networkID).runExclusive(async () => {
			const entry = this.running.get(networkID);
			const row = this.deps.getRow(networkID);
			if (!entry || !row?.overlay) return;
			await this.writeConfig(entry, row.overlay);
			if (entry.helper.isRunning()) await entry.helper.reload();
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
		const { changed, previous } = await this.lock(networkID).runExclusive(async () => {
			const previous = await this.currentState(networkID, overlay);
			if (previous && incoming.version <= previous.version) return { changed: false, previous };
			await store.writeJSON('state.json', signed);
			this.deps.saveOverlay(networkID, applyState(overlay, incoming));
			return { changed: true, previous };
		});
		const held = changed ? incoming : previous!;
		if (store.has('ca.key')) {
			const union = [...new Set([...(previous?.revoked ?? []), ...incoming.revoked])];
			if (union.length > held.revoked.length) {
				await this.publishNewState(networkID, { lighthouses: held.lighthouses, relays: held.relays, revoked: union });
				return true;
			}
		}
		if (!changed) {
			// The sender is behind; our newer state reaches it through the topic.
			if (incoming.version < held.version) void this.publishState(networkID, false);
			return false;
		}
		console.log(`[Overlay ${networkID.slice(0, 8)}] accepted network state v${incoming.version} (${incoming.lighthouses.length} lighthouse(s), ${incoming.relays.length} relay(s), ${incoming.revoked.length} revoked)`);
		this.deps.onStateChange(networkID, incoming);
		await this.reconfigure(networkID);
		void this.publishState(networkID, false);
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
		const state: OverlayState = { networkID, version: nextVersion(Math.max(current?.version ?? 0, row.overlay.version)), lighthouses: change.lighthouses, relays: change.relays, revoked: change.revoked };
		const signed = await signState(state, caKey);
		if (!(await this.acceptState(networkID, signed))) throw new Error('the new network state was not accepted');
		return state;
	}

	/** Publish the newest state on the lishnet's state topic. `periodic` skips the rate limit of event-driven sends. */
	async publishState(networkID: string, periodic: boolean): Promise<void> {
		const entry = this.running.get(networkID);
		if (!entry) return;
		const now = Date.now();
		if (!periodic && now - entry.lastPublish < STATE_PUBLISH_MIN_GAP_MS) return;
		const signed = await entry.store.readState();
		if (!signed) return;
		entry.lastPublish = now;
		await entry.network.broadcast(stateTopic(networkID), { type: 'overlayState', signed }).catch(() => {});
	}
}
