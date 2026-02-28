export class Utils {
	static formatBytes(bytes: number, decimals: number = 2): string {
		if (bytes === 0) return '0 Bytes';
		const k = 1024;
		const dm = decimals < 0 ? 0 : decimals;
		const sizes = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
	}

	static parseBytes(value: string | number): number {
		if (typeof value === 'number') return value;
		const match = value
			.trim()
			.toUpperCase()
			.match(/^(\d+(?:\.\d+)?)\s*([KMGTPEZY])?B?$/);
		if (!match) throw new Error('Invalid size format. Use number with optional suffix: K, M, G, T, P, E, Z, Y');
		const [, num, suffix] = match;
		if (!suffix) return Math.floor(parseFloat(num!));
		const sizes = ['', 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'];
		const i = sizes.indexOf(suffix);
		return Math.floor(parseFloat(num!) * Math.pow(1024, i));
	}

	static expandHome(path: string): string {
		// expand ~ to home directory
		if (path.startsWith('~')) {
			const home = process.env['HOME'] || process.env['USERPROFILE'];
			if (home) return home + path.slice(1);
		}
		return path;
	}

	/**
	 * Parse JSON with a descriptive error message on failure.
	 * Use this for user-provided or external data where the source is helpful for debugging.
	 */
	static safeJsonParse<T = unknown>(text: string, source: string): T {
		try {
			return JSON.parse(text);
		} catch (err: any) {
			throw new Error(`Invalid JSON from ${source}: ${err.message}`);
		}
	}

	/**
	 * Validate that all required parameters are present.
	 * Throws a descriptive error if any are missing (undefined).
	 */
	static assertParams<K extends string>(params: Record<string, any>, required: K[]): void {
		for (const key of required) {
			if (params[key] === undefined) throw new Error(`Missing required parameter: ${key}`);
		}
	}
}
