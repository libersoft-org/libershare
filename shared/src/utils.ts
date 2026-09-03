import { CodedError, ErrorCodes } from './errors.ts';

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
	if (!match) throw new CodedError(ErrorCodes.INVALID_SIZE_FORMAT);
	const [, num, suffix] = match;
	if (!suffix) return Math.floor(parseFloat(num!));
	const sizes = ['', 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'];
	const i = sizes.indexOf(suffix);
	return Math.floor(parseFloat(num!) * Math.pow(1024, i));
}

/**
 * Strip characters a file name may not contain and normalise whitespace.
 *
 * The control range goes too: a NUL truncates the path at the system-call
 * boundary, so a name containing one can address a different file than the one
 * it appears to name, and the rest of C0 makes for names that cannot be typed,
 * listed or deleted through ordinary tools.
 */
export function sanitizeFilename(filename: string): string {
	return filename
		.replace(/[<>:"/\\|?*]/g, '')
		.replace(/\p{Cc}/gu, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Keep at most `maxBytes` UTF-8 bytes from the end of `value`, never splitting a
 * character. Byte length is what a filesystem limits — the usual cap is 255
 * bytes per path component — while `String.length` counts UTF-16 units, so a
 * hundred emoji or CJK characters measure as well within a hundred-character
 * budget and still overflow the real one several times over.
 */
export function truncateUTF8End(value: string, maxBytes: number): string {
	const bytes = new TextEncoder().encode(value);
	if (bytes.byteLength <= maxBytes) return value;
	let start = bytes.byteLength - maxBytes;
	// Walk forward off any continuation byte, so the slice begins on a character.
	while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start++;
	return new TextDecoder().decode(bytes.subarray(start));
}
