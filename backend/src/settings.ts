import { mkdir } from 'fs/promises';
import { Mutex } from 'async-mutex';
import { JSONStorage } from './storage.ts';
import { Utils } from './utils.ts';
import { productName, productEnvPrefix, minMessageSizeFor, DEFAULT_MAX_RELAY_RESERVATIONS, type CompressionAlgorithm } from '@shared';
// Default upper bound for chunk size accepted by the app (configurable via settings).
export const DEFAULT_MAX_CHUNK_SIZE: number = 100 * 1024 * 1024;
// Default upper bound for a single P2P message on the wire (configurable via settings).
// Must be >= maxChunkSize because a chunk is delivered as a single msgpack message.
export const DEFAULT_MAX_MESSAGE_SIZE: number = 128 * 1024 * 1024;

export interface SettingsData {
	language: string;
	ui: {
		cursorSize: 'small' | 'medium' | 'large';
		footerVisible: boolean;
		footerPosition: 'left' | 'center' | 'right';
		footerWidgets: Record<string, boolean>;
		timeFormat24h: boolean;
		showSeconds: boolean;
	};
	audio: {
		enabled: boolean;
		volume: number;
	};
	storage: {
		downloadPath: string;
		tempPath: string;
		lishPath: string;
		lishnetPath: string;
		backupPath: string;
	};
	network: {
		incomingPort: number;
		maxDownloadPeersPerLISH: number;
		maxUploadPeersPerLISH: number;
		maxDownloadSpeed: number;
		maxUploadSpeed: number;
		maxChunkSize: number;
		maxMessageSize: number;
		allowRelay: boolean;
		/** How many other peers may reserve a relay slot ON US (we are the relay server). 0 = unlimited. */
		maxRelayReservations: number;
		/**
		 * Master switch for the circuit-relay CLIENT role. When false, this node will not
		 * reserve relay slots on other peers regardless of `maxRelayClients`. When true,
		 * `maxRelayClients` defines how many slots to reserve.
		 */
		useRelayClients: boolean;
		/** How many other peers' relays we use AS A CLIENT (`discoverRelays` + `/p2p-circuit` listen slots). */
		maxRelayClients: number;
		autoStartSharing: boolean;
		autoStartDownloading: boolean;
		autoErrorRecovery: boolean;
		/**
		 * When true, networks added via API (manual form or public-list import) are
		 * immediately set to enabled=true so the node joins them without an extra click.
		 * Backwards-compatible: missing field is treated as true.
		 */
		autoConnectNewNetworks: boolean;
		announceAddresses: string[];
		/**
		 * Which host interface the UI treats as primary (its `id`: the adapter GUID
		 * on Windows, the device name elsewhere). Empty = follow the IPv4 default
		 * route.
		 *
		 * Display-only: it selects what the Settings screen highlights and what the
		 * footer connection widget reports. It deliberately does NOT influence
		 * libp2p announce or address filtering.
		 */
		primaryInterface: string;
		mdnsEnabled: boolean;
		mdnsInterval: number;
		/**
		 * UPnP-NAT port forwarding. When true, libp2p asks the local router (IGD)
		 * to forward the incoming port to this host. Default true so NAT'd nodes
		 * become reachable out of the box; set false to leave router state untouched.
		 */
		upnpEnabled: boolean;
		searchTimeout: number; // Browse network → LISH search timeout in milliseconds. Search session ends after this.
		/**
		 * GossipSub Peer Exchange (PX) local operator policy.
		 *
		 * PX allows peers to recommend other peers to each other through PRUNE control messages
		 * (see GossipSub v1.1 spec). Sybil-style injection is neutralised by a two-layer defence:
		 * (1) gossipsub scoring + acceptPXThreshold so only peers above a positive score can
		 * deliver PX, and (2) an ingress filter that strips PRUNE peer lists unless the sender
		 * is trusted. Trust is granted automatically to bootstrap peers (operator already chose
		 * them at lishnet-join time) and extended by the optional trustedPeerIds list.
		 */
		peerExchange: {
			/**
			 * Master switch for doPX emission (we advertise peers when pruning) AND for the
			 * local trust score that makes an individual peer's PX acceptable inbound.
			 * When false the score path fails closed for every peer, including bootstraps.
			 */
			enabled: boolean;
			/**
			 * Minimum gossipsub score a sender must reach before its PX is accepted. Must be
			 * above the neutral appSpecificScore baseline (1) to keep non-trusted peers from
			 * supplying peer lists. Unsafe values (<= 1, non-finite, non-number) fall back to
			 * the safe default.
			 */
			acceptPXThreshold: number;
			/**
			 * Extra allow-list of peer IDs on top of bootstrap peers. The appSpecificScore
			 * boost (+1000) is given to any peer that is either in this list OR in the
			 * bootstrap set derived from the lishnets this node has joined. Leave empty to
			 * rely purely on bootstrap trust.
			 */
			trustedPeerIds: string[];
			/**
			 * Independent defense-in-depth: when true, the gossipsub handleReceivedRpc wrapper
			 * strips `peers` from any PRUNE control message unless the sender is trusted
			 * (configured OR bootstrap) AND the topic is under the lishnet namespace. Can be
			 * enabled without `enabled` (belt-and-braces) or disabled to rely purely on scoring.
			 */
			ingressFilterEnabled: boolean;
		};
	};
	system: {
		autoStartOnBoot: boolean;
		showInTray: boolean;
		minimizeToTray: boolean;
		notificationTimeout: number;
	};
	export: {
		minifyJSON: boolean;
		compress: boolean;
		compressionAlgorithm: CompressionAlgorithm;
	};
	input: {
		initialDelay: number;
		repeatDelay: number;
		gamepadDeadzone: number;
	};
}

function storagePath(envName: string, defaultRelative: string, fallback: string): string {
	const explicit = process.env[envName];
	if (explicit) return explicit;
	const root = process.env['STORAGE_ROOT'];
	if (!root) return fallback;
	return `${root.replace(/[\\/]+$/, '')}/${defaultRelative}/`;
}

const DEFAULT_SETTINGS: SettingsData = {
	language: '',
	ui: {
		cursorSize: 'medium',
		footerVisible: true,
		footerPosition: 'right',
		footerWidgets: {
			version: false,
			peerId: true,
			download: true,
			upload: true,
			relay: false,
			cpu: false,
			ram: false,
			storage: false,
			lishStatus: true,
			gamepad: false,
			connection: true,
			volume: true,
			clock: true,
		},
		timeFormat24h: true,
		showSeconds: false,
	},
	audio: {
		enabled: true,
		volume: 50,
	},
	storage: {
		downloadPath: storagePath(`${productEnvPrefix}_DOWNLOAD_PATH`, 'finished', `~/${productName}/finished/`),
		tempPath: storagePath(`${productEnvPrefix}_TEMP_PATH`, 'temp', `~/${productName}/temp/`),
		lishPath: storagePath(`${productEnvPrefix}_LISH_PATH`, 'lish', `~/${productName}/lish/`),
		lishnetPath: storagePath(`${productEnvPrefix}_LISHNET_PATH`, 'lishnet', `~/${productName}/lishnet/`),
		backupPath: storagePath(`${productEnvPrefix}_BACKUP_PATH`, 'backup', `~/${productName}/backup/`),
	},
	network: {
		incomingPort: 9090,
		maxDownloadPeersPerLISH: 30,
		maxUploadPeersPerLISH: 30,
		maxDownloadSpeed: 0,
		maxUploadSpeed: 0,
		maxChunkSize: DEFAULT_MAX_CHUNK_SIZE,
		maxMessageSize: DEFAULT_MAX_MESSAGE_SIZE,
		allowRelay: false,
		maxRelayReservations: DEFAULT_MAX_RELAY_RESERVATIONS,
		useRelayClients: true,
		maxRelayClients: 5,
		autoStartSharing: true,
		autoStartDownloading: true,
		autoErrorRecovery: true,
		autoConnectNewNetworks: true,
		announceAddresses: [],
		primaryInterface: '',
		mdnsEnabled: true,
		mdnsInterval: 30000,
		// UPnP enabled by default so NAT'd nodes auto-open their port for reachability.
		upnpEnabled: true,
		searchTimeout: 30_000,
		peerExchange: {
			// Enabled by default: bootstrap peers (operator-configured in lishnet joins)
			// are automatically trusted PX sources, so mesh density converges without
			// operator having to seed trustedPeerIds manually. See
			// network-config.ts appSpecificScore for the bootstrap-trust rationale.
			enabled: true,
			acceptPXThreshold: 5,
			trustedPeerIds: [],
			// Defense-in-depth: even if a non-bootstrap peer somehow crosses the score
			// threshold, the ingress filter still strips its PX peer list unless it is
			// in the trusted set (configured OR bootstrap).
			ingressFilterEnabled: true,
		},
	},
	system: {
		autoStartOnBoot: true,
		showInTray: true,
		minimizeToTray: true,
		notificationTimeout: 5,
	},
	export: {
		minifyJSON: false,
		compress: false,
		compressionAlgorithm: 'gzip' as CompressionAlgorithm,
	},
	input: {
		initialDelay: 400,
		repeatDelay: 150,
		gamepadDeadzone: 0.5,
	},
};

/**
 * Settings storage.
 * Wraps JSONStorage with SettingsData type.
 */
export class Settings {
	private storage!: JSONStorage<SettingsData>;
	/**
	 * One writer at a time, across every path that writes settings.
	 *
	 * An import writes key by key and awaits between them, while the factory reset restores
	 * the defaults through the same storage. Interleaved, the stored file ended up part
	 * imported and part default and both operations reported success — and the node reads
	 * some of these values only when it is built, so the mixture outlived the request.
	 *
	 * The lock belongs here rather than in the handlers because this class is the one place
	 * every writer goes through: the API, the import and the reset.
	 */
	private readonly writeLock = new Mutex();

	private constructor() {}

	static async create(dataDir: string): Promise<Settings> {
		const instance = new Settings();
		instance.storage = await JSONStorage.create(dataDir, 'settings.json', DEFAULT_SETTINGS);
		return instance;
	}

	get(path?: string): any {
		return this.storage.get(path);
	}

	async set(path: string, value: any): Promise<void> {
		await this.writeLock.runExclusive(async () => {
			await this.storage.set(path, value);
			await this.repair();
		});
	}

	/**
	 * Write many keys as one operation, keeping the ones the storage rejects out of the way.
	 *
	 * An import is a single user action and has to land as one: applied key by key without
	 * the lock, a reset arriving mid-loop split the result between the two.
	 *
	 * Not all-or-nothing — a key the storage rejects is reported and the rest still lands.
	 * What the lock buys is that no other writer sees or extends the half-written document.
	 */
	async setMany(entries: ReadonlyArray<{ path: string; value: any }>): Promise<{ applied: number; skipped: string[] }> {
		return await this.writeLock.runExclusive(() => this.storage.setMany(entries, draft => Settings.repairDraft(draft)));
	}

	/**
	 * Bring a stored message-size limit that cannot carry one chunk back up to the floor.
	 *
	 * Runs inside the write lock, on the document the caller just wrote. Done afterwards from
	 * the handler instead, it was a read and a write with a gap in the middle: a second import
	 * could land between them, and the repair then wrote a floor derived from the FIRST
	 * import's chunk size over the second one's message size — leaving a pair neither import
	 * asked for, with both reporting success.
	 *
	 * The protocol layer enforces the same floor at runtime; persisting it keeps the settings
	 * screen from showing a value the protocol silently overrides.
	 */
	private async repair(): Promise<void> {
		const floor = minMessageSizeFor(this.storage.get('network.maxChunkSize'));
		if (this.storage.get('network.maxMessageSize') < floor) await this.storage.set('network.maxMessageSize', floor);
	}

	/** As {@link Settings.repair}, on a batch that has not been published yet. */
	private static repairDraft(draft: SettingsData): void {
		const floor = minMessageSizeFor(draft.network.maxChunkSize);
		if (draft.network.maxMessageSize < floor) draft.network.maxMessageSize = floor;
	}

	list(): SettingsData {
		return this.storage.list();
	}

	getDefaults(): SettingsData {
		return structuredClone(DEFAULT_SETTINGS);
	}

	async reset(): Promise<SettingsData> {
		return await this.writeLock.runExclusive(() => this.storage.reset());
	}

	/** Create all storage directories from current settings (expanding ~ to home). */
	async ensureStorageDirs(): Promise<void> {
		const storage = this.get('storage') as SettingsData['storage'];
		const paths = [storage.downloadPath, storage.tempPath, storage.lishPath, storage.lishnetPath, storage.backupPath];
		for (const p of paths) {
			const resolved = Utils.expandHome(p);
			await mkdir(resolved, { recursive: true });
		}
	}
}

/**
 * Live reader for the `network` settings group, registered once at startup.
 * Null until then — module-level code (tests, imports evaluated before the
 * settings file is loaded) falls back to the defaults.
 */
let liveNetwork: (() => SettingsData['network']) | null = null;

/**
 * Point {@link networkSetting} at the running Settings instance. Called once from
 * the entry point; every later settings write is picked up automatically because
 * the reader hits the live object rather than a copy.
 */
export function useNetworkSettings(read: () => SettingsData['network']): void {
	liveNetwork = read;
}

/**
 * Current value of one `network.*` limit, read straight from settings on every
 * call. Consumers must not cache it in module state: a stale copy is exactly the
 * bug this replaces — a limit applied in one code path and silently forgotten in
 * another. Falls back to the built-in default before registration.
 */
export function networkSetting<K extends keyof SettingsData['network']>(key: K): SettingsData['network'][K] {
	return (liveNetwork?.() ?? DEFAULT_SETTINGS.network)[key];
}
