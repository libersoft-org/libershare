import { mkdir } from 'fs/promises';
import { JsonStorage } from './storage.ts';
import { Utils } from './utils.ts';

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
		announceAddresses: string[];
	};
	system: {
		autoStartOnBoot: boolean;
		showInTray: boolean;
		minimizeToTray: boolean;
	};
	export: {
		minifyJson: boolean;
		compressGzip: boolean;
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
		announceAddresses: [],
	},
	system: {
		autoStartOnBoot: true,
		showInTray: true,
		minimizeToTray: true,
	},
	export: {
		minifyJson: false,
		compressGzip: false,
	},
	input: {
		initialDelay: 400,
		repeatDelay: 150,
		gamepadDeadzone: 0.5,
	},
};

/**
 * Settings storage.
 * Wraps JsonStorage with SettingsData type.
 */
export class Settings {
	private storage: JsonStorage<SettingsData>;

	constructor(dataDir: string) {
		this.storage = new JsonStorage(dataDir, 'settings.json', DEFAULT_SETTINGS);
	}

	get(path?: string): any {
		return this.storage.get(path);
	}

	set(path: string, value: any): void {
		this.storage.set(path, value);
	}

	getAll(): SettingsData {
		return this.storage.getAll();
	}

	getDefaults(): SettingsData {
		return structuredClone(DEFAULT_SETTINGS);
	}

	reset(): SettingsData {
		return this.storage.reset();
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
