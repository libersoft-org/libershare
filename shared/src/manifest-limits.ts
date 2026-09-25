import { CodedError, ErrorCodes } from './errors.ts';
import { formatUntrustedValue } from './untrusted-value.ts';

/** Longest entry path or link target, in UTF-8 bytes. */
export const MAX_MANIFEST_PATH_BYTES = 4096;
/** Longest LISH id, in UTF-8 bytes. Existing ids are not required to be UUIDs. */
export const MAX_MANIFEST_ID_BYTES = 256;
/** Longest LISH name, in UTF-8 bytes. */
export const MAX_MANIFEST_NAME_BYTES = 1024;
/** Longest LISH description, in UTF-8 bytes. */
export const MAX_MANIFEST_DESCRIPTION_BYTES = 65536;
/** Longest single checksum value, in ASCII characters. */
export const MAX_CHECKSUM_LENGTH = 128;

const encoder = new TextEncoder();
const NUL = String.fromCharCode(0);

/**
 * Whether `value` fits in `maxBytes` of UTF-8. Every UTF-16 unit needs at least one byte, so a
 * string longer than the limit is refused before anything is encoded.
 */
export function fitsUTF8(value: string, maxBytes: number): boolean {
	return value.length <= maxBytes && encoder.encode(value).length <= maxBytes;
}

function invalid(detail: string): CodedError {
	return new CodedError(ErrorCodes.LISH_INVALID_MANIFEST, detail);
}

/** Refuse a text field that is present but not a string or longer than `maxBytes`. */
export function checkTextField(name: string, value: unknown, maxBytes: number, required: boolean): void {
	if (value === undefined && !required) return;
	if (typeof value !== 'string' || (required && value.length === 0)) throw invalid(`${name} is not a string: ${formatUntrustedValue(value)}`);
	if (!fitsUTF8(value, maxBytes)) throw invalid(`${name} is longer than ${maxBytes} bytes: ${formatUntrustedValue(value)}`);
}

/** Refuse an entry path that is not a string or longer than {@link MAX_MANIFEST_PATH_BYTES}. */
export function checkEntryPath(kind: string, path: unknown): string {
	if (typeof path !== 'string') throw invalid(`${kind} path is not a string: ${formatUntrustedValue(path)}`);
	if (!fitsUTF8(path, MAX_MANIFEST_PATH_BYTES)) throw invalid(`${kind} path is longer than ${MAX_MANIFEST_PATH_BYTES} bytes: ${formatUntrustedValue(path)}`);
	return path;
}

/** Refuse a checksum that is not a short printable ASCII string. */
export function checkChecksum(path: string, checksum: unknown): void {
	if (typeof checksum !== 'string') throw invalid(`${formatUntrustedValue(path)}: non-string checksum`);
	if (checksum.length === 0 || checksum.length > MAX_CHECKSUM_LENGTH || !/^[\x21-\x7e]+$/.test(checksum)) throw invalid(`${formatUntrustedValue(path)}: invalid checksum ${formatUntrustedValue(checksum)}`);
}

/**
 * Check that the entries form one consistent tree: no two entries at the same path, and no
 * file or link where another entry needs a directory — an explicit one or an implicit parent
 * (`a` against `a/b.bin`). A directory that repeats an implicit parent is fine. Empty and `.`
 * components are refused instead of being rewritten, so no textual alias of a path exists.
 * Case and Unicode are left alone: whether two names collide on disk is for the writer to
 * decide, not a global rule here.
 *
 * Sorting with the separator as the smallest character puts every descendant of a path right
 * after it, so comparing neighbours finds each conflict in O(n log n) without building any
 * prefix strings.
 */
export function checkEntryTree(directories: readonly { path: string }[], leaves: readonly { path: string }[]): void {
	const entries: { key: string; path: string; leaf: boolean }[] = [];
	const add = (path: string, leaf: boolean): void => {
		if (path.includes(NUL)) throw invalid(`NUL in path: ${formatUntrustedValue(path)}`);
		if (path.split('/').some(part => part === '' || part === '.')) throw invalid(`empty or '.' path component: ${formatUntrustedValue(path)}`);
		entries.push({ key: path.replaceAll('/', NUL), path, leaf });
	};
	for (const { path } of directories) add(path, false);
	for (const { path } of leaves) add(path, true);
	entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	for (let i = 1; i < entries.length; i++) {
		const prev = entries[i - 1]!;
		const next = entries[i]!;
		if (next.key === prev.key) throw invalid(`duplicate entry path: ${formatUntrustedValue(next.path)}`);
		if (prev.leaf && next.key.startsWith(prev.key + NUL)) throw invalid(`entry path is also a directory: ${formatUntrustedValue(prev.path)}`);
	}
}
