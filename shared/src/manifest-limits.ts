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
