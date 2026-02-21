import { JsonStorage } from './storage.ts';
import { homedir, platform } from 'os';
import { join, sep } from 'path';
import { mkdirSync } from 'fs';

function getDefaultStoragePaths(): SettingsData['storage'] {
	const home = homedir();
	const isWindows = platform() === 'win32';
	const isMac = platform() === 'darwin';

	const baseDir = isWindows || isMac
		? join(home, 'Downloads', 'LiberShare')
		: join(home, 'download');

	const trailingSep = (p: string) => p.endsWith(sep) ? p : p + sep;

	return {
		downloadPath: trailingSep(join(baseDir, 'finished')),
		tempPath: trailingSep(join(baseDir, 'temp')),
		lishPath: trailingSep(join(baseDir, 'lish')),
		lishnetPath: trailingSep(join(baseDir, 'lishnet')),
	};
}

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
	storage: getDefaultStoragePaths(),
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
		this.ensureStorageDirs();
	}

	private ensureStorageDirs(): void {
		const paths = this.storage.get('storage') as SettingsData['storage'];
		for (const dir of [paths.downloadPath, paths.tempPath, paths.lishPath, paths.lishnetPath]) {
			try { mkdirSync(dir, { recursive: true }); } catch {}
		}
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

}
