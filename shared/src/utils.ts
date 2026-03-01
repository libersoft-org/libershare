export function formatBytes(bytes: number, decimals: number = 2): string {
	if (bytes === 0) return '0 Bytes';
	const k = 1024;
	const dm = decimals < 0 ? 0 : decimals;
	const sizes = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export function parseBytes(value: string | number): number {
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
