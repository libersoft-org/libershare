import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface FrontendSettings {
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
		autoStartSharing: boolean;
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

const DEFAULT_SETTINGS: FrontendSettings = {
	language: 'en',
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
		downloadPath: '~/libershare/download/',
		tempPath: '~/libershare/temp/',
		lishPath: '~/libershare/lish/',
		lishnetPath: '~/libershare/lishnet/',
	},
	network: {
		incomingPort: 9090,
		maxDownloadConnections: 200,
		maxUploadConnections: 200,
		maxDownloadSpeed: 0,
		maxUploadSpeed: 0,
		autoStartSharing: true,
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

export class Settings {
	private settings: FrontendSettings;
	private readonly filePath: string;

	constructor(dataDir: string) {
		this.filePath = join(dataDir, 'frontend-settings.json');
		this.settings = this.load();
	}

	private load(): FrontendSettings {
		if (!existsSync(this.filePath)) {
			this.save(DEFAULT_SETTINGS);
			return { ...DEFAULT_SETTINGS };
		}
		try {
			const data = readFileSync(this.filePath, 'utf-8');
			const loaded = JSON.parse(data);
			// Deep merge with defaults to ensure all keys exist
			return this.deepMerge(DEFAULT_SETTINGS, loaded);
		} catch (error) {
			console.error('[Settings] Error loading settings:', error);
			return { ...DEFAULT_SETTINGS };
		}
	}

	private save(settings: FrontendSettings): void {
		try {
			writeFileSync(this.filePath, JSON.stringify(settings, null, '\t'));
		} catch (error) {
			console.error('[Settings] Error saving settings:', error);
		}
	}

	private deepMerge<T extends Record<string, any>>(defaults: T, override: Partial<T>): T {
		const result = { ...defaults };
		for (const key in override) {
			if (override[key] !== undefined) {
				if (typeof defaults[key] === 'object' && defaults[key] !== null && !Array.isArray(defaults[key])) {
					result[key] = this.deepMerge(defaults[key], override[key] as any);
				} else {
					result[key] = override[key] as any;
				}
			}
		}
		return result;
	}

	/**
	 * Get value at path (e.g., "ui.cursorSize" or "audio.volume")
	 */
	get(path?: string): any {
		if (!path) return this.settings;
		const keys = path.split('.');
		let value: any = this.settings;
		for (const key of keys) {
			if (value === undefined || value === null) return undefined;
			value = value[key];
		}
		return value;
	}

	/**
	 * Set value at path (e.g., "ui.cursorSize", "medium")
	 */
	set(path: string, value: any): void {
		const keys = path.split('.');
		let obj: any = this.settings;
		for (let i = 0; i < keys.length - 1; i++) {
			const key = keys[i];
			if (obj[key] === undefined) obj[key] = {};
			obj = obj[key];
		}
		obj[keys[keys.length - 1]] = value;
		this.save(this.settings);
	}

	/**
	 * Get all settings
	 */
	getAll(): FrontendSettings {
		return this.settings;
	}

	/**
	 * Reset to defaults
	 */
	reset(): FrontendSettings {
		this.settings = { ...DEFAULT_SETTINGS };
		this.save(this.settings);
		return this.settings;
	}
}
