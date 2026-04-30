import { mkdir } from 'fs/promises';
import { JSONStorage } from './storage.ts';
import { Utils } from './utils.ts';
import { type CompressionAlgorithm } from '@shared';
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
		maxRelayReservations: number;
		autoStartSharing: boolean;
		autoStartDownloading: boolean;
		autoErrorRecovery: boolean;
		announceAddresses: string[];
		mdnsEnabled: boolean;
		mdnsInterval: number;
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
			 * strictly positive to keep neutral (score=0) peers from supplying peer lists.
			 * Unsafe values (<= 0, non-finite, non-number) fall back to the safe default.
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

const DEFAULT_SETTINGS: SettingsData = {
	language: '',
	ui: {
		cursorSize: 'medium',
		footerVisible: true,
		footerPosition: 'right',
		footerWidgets: {
			version: false,
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
		downloadPath: '~/LiberShare/finished/',
		tempPath: '~/LiberShare/temp/',
		lishPath: '~/LiberShare/lish/',
		lishnetPath: '~/LiberShare/lishnet/',
		backupPath: '~/LiberShare/backup/',
	},
	network: {
		incomingPort: 9090,
		maxDownloadPeersPerLISH: 30,
		maxUploadPeersPerLISH: 30,
		maxDownloadSpeed: 0,
		maxUploadSpeed: 0,
		maxChunkSize: DEFAULT_MAX_CHUNK_SIZE,
		maxMessageSize: DEFAULT_MAX_MESSAGE_SIZE,
		allowRelay: true,
		maxRelayReservations: 0,
		autoStartSharing: true,
		autoStartDownloading: true,
		autoErrorRecovery: true,
		announceAddresses: [],
		mdnsEnabled: true,
		mdnsInterval: 30000,
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
		await this.storage.set(path, value);
	}

	list(): SettingsData {
		return this.storage.list();
	}

	getDefaults(): SettingsData {
		return structuredClone(DEFAULT_SETTINGS);
	}

	async reset(): Promise<SettingsData> {
		return await this.storage.reset();
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
