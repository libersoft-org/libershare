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
		if (!suffix) return Math.floor(parseFloat(num));
		const sizes = ['', 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'];
		const i = sizes.indexOf(suffix);
		return Math.floor(parseFloat(num) * Math.pow(1024, i));
	}

	static encodeBase62(bytes: Uint8Array): string {
		const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
		// Convert bytes to a BigInt
		let num = 0n;
		for (const byte of bytes) num = (num << 8n) | BigInt(byte);
		if (num === 0n) return '0';
		// Convert to base62
		let result = '';
		while (num > 0n) {
			result = chars[Number(num % 62n)] + result;
			num = num / 62n;
		}
		return result;
	}

	static decodeBase62(str: string): Uint8Array {
		const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
		// Convert base62 string to BigInt
		let num = 0n;
		for (const char of str) {
			const index = chars.indexOf(char);
			if (index === -1) throw new Error(`Invalid base62 character: ${char}`);
			num = num * 62n + BigInt(index);
		}
		if (num === 0n) return new Uint8Array([0]);
		// Convert BigInt to bytes
		const bytes: number[] = [];
		while (num > 0n) {
			bytes.unshift(Number(num & 0xffn));
			num = num >> 8n;
		}
		return new Uint8Array(bytes);
	}

	static expandHome(path: string): string {
		// expand ~ to home directory
		if (path.startsWith('~')) {
			const home = process.env.HOME || process.env.USERPROFILE;
			if (home) return home + path.slice(1);
		}
	}
}
