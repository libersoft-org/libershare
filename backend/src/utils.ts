export class Utils {
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
