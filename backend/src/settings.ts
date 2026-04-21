import { mkdir } from 'fs/promises';
import { JSONStorage } from './storage.ts';
import { Utils } from './utils.ts';
import { type CompressionAlgorithm } from '@shared';

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
	};
	network: {
		incomingPort: number;
		maxDownloadConnections: number;
		maxUploadConnections: number;
		maxDownloadSpeed: number;
		maxUploadSpeed: number;
		allowRelay: boolean;
		maxRelayReservations: number;
		autoStartSharing: boolean;
		autoStartDownloading: boolean;
		autoErrorRecovery: boolean;
		announceAddresses: string[];
		mdnsEnabled: boolean;
		mdnsInterval: number;
		/**
		 * GossipSub Peer Exchange (PX) local operator policy.
		 *
		 * PX allows peers to recommend other peers to each other through PRUNE control messages
		 * (see GossipSub v1.1 spec). This exposes the mesh to Sybil-style injection if PX is
		 * accepted from untrusted senders, so LiberShare ships a fail-closed default: PX is
		 * disabled, no peers are trusted, and no ingress is filtered. Operators opt in per node.
		 */
		peerExchange: {
			/**
			 * Master switch for doPX emission (we advertise peers when pruning) AND for the
			 * local trust score that makes an individual peer's PX acceptable inbound.
			 * When false the score path fails closed regardless of trustedPeerIds.
			 */
			enabled: boolean;
			/**
			 * Minimum gossipsub score a sender must reach before its PX is accepted. Must be
			 * strictly positive to keep neutral (score=0) peers from supplying peer lists.
			 * Unsafe values (<= 0, non-finite, non-number) fall back to the safe default.
			 */
			acceptPXThreshold: number;
			/**
			 * Explicit allow-list of peer IDs that receive a trust boost via appSpecificScore.
			 * Only these peers can cross acceptPXThreshold via the trust signal alone. Empty
			 * list + enabled=true means PX is emitted but nobody is trusted to receive it.
			 */
			trustedPeerIds: string[];
			/**
			 * Independent defense-in-depth: when true, the gossipsub handleReceivedRpc wrapper
			 * strips `peers` from any PRUNE control message unless the sender is in
			 * trustedPeerIds AND the topic is under the lishnet namespace. Can be enabled
			 * without `enabled` (belt-and-braces) or disabled to rely purely on scoring.
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
			cpu: false,
			ram: false,
			storage: false,
			lishStatus: true,
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
	},
	network: {
		incomingPort: 9090,
		maxDownloadConnections: 200,
		maxUploadConnections: 200,
		maxDownloadSpeed: 0,
		maxUploadSpeed: 0,
		allowRelay: true,
		maxRelayReservations: 0,
		autoStartSharing: true,
		autoStartDownloading: true,
		autoErrorRecovery: true,
		announceAddresses: [],
		mdnsEnabled: true,
		mdnsInterval: 10000,
		peerExchange: {
			enabled: false,
			acceptPXThreshold: 10,
			trustedPeerIds: [],
			ingressFilterEnabled: false,
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
		const paths = [storage.downloadPath, storage.tempPath, storage.lishPath, storage.lishnetPath];
		for (const p of paths) {
			const resolved = Utils.expandHome(p);
			await mkdir(resolved, { recursive: true });
		}
	}
}
