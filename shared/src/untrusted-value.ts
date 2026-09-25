/** Longest part of an untrusted string kept before it is escaped. */
const MAX_TEXT_UNITS = 64;
/** Upper bound of one formatted value, whatever its content. */
const MAX_FORMATTED = 400;

/**
 * Characters that must never reach a log, a database row or a screen as themselves: C0 and DEL,
 * C1, the line/paragraph separators and the bidirectional overrides that can make a line read
 * differently from what it contains. JSON.stringify already escapes C0.
 */
const UNSAFE_CHARS = /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;

/**
 * Render a value that came from an untrusted source — a peer's manifest, an imported file — as
 * one short, escaped fragment for an error detail. A string keeps at most its first 64 UTF-16
 * units (never splitting a surrogate pair) and gets `...` when cut; objects, arrays, functions
 * and symbols are named by type only, so nothing of theirs is called or walked.
 */
export function formatUntrustedValue(value: unknown): string {
	if (typeof value === 'string') {
		let end = Math.min(value.length, MAX_TEXT_UNITS);
		// A high surrogate right at the cut would be half a character.
		if (end < value.length && end > 0) {
			const code = value.charCodeAt(end - 1);
			if (code >= 0xd800 && code <= 0xdbff) end--;
		}
		const cut = end < value.length;
		const quoted = JSON.stringify(value.slice(0, end)).replace(UNSAFE_CHARS, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
		return (cut ? `${quoted}...` : quoted).slice(0, MAX_FORMATTED);
	}
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (typeof value === 'number') return String(value).slice(0, 32);
	if (typeof value === 'boolean') return String(value);
	if (typeof value === 'bigint') return 'bigint';
	if (Array.isArray(value)) return 'array';
	if (ArrayBuffer.isView(value)) return 'typed array';
	return typeof value;
}

/** Most characters a validation detail may hold; built from bounded fragments, capped as a backstop. */
export const MAX_VALIDATION_DETAIL = 1024;

/** Cap a detail assembled from bounded fragments, marking a cut. */
export function boundDetail(detail: string, max: number = MAX_VALIDATION_DETAIL): string {
	return detail.length <= max ? detail : `${detail.slice(0, max - 3)}...`;
}
