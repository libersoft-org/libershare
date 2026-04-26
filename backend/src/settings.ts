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
