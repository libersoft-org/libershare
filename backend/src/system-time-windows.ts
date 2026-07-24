import { dlopen, FFIType, ptr } from 'bun:ffi';

/**
 * IANA to Windows timezone identifier conversion, done in-process through the ICU
 * library Windows itself ships (`icu.dll`, present since Windows 10 1703) via
 * `bun:ffi`. No child process, no PowerShell, and no CLDR table bundled into the
 * repository that would go stale with every timezone rule change.
 *
 * The conversion is needed because `tzutil` only understands Windows identifiers
 * ("Central Europe Standard Time") while every other platform — and our UI — speaks
 * IANA ("Europe/Prague"), and the mapping is a curated CLDR table that cannot be
 * derived from UTC offsets. Only this direction is implemented: the reverse mapping
 * is lossy (several IANA zones share one Windows zone, and ICU answers with the
 * region's representative, which is usually a different city than the user picked),
 * so the current zone is always read from the runtime's own ICU instead.
 */

/** ICU string arguments are UTF-16 code-unit arrays, not NUL-terminated C strings. */
function toUtf16(value: string): Uint16Array {
	const buffer = new Uint16Array(value.length);
	for (let i = 0; i < value.length; i++) buffer[i] = value.charCodeAt(i);
	return buffer;
}

interface Icu {
	ucal_getWindowsTimeZoneID: (id: number, len: number, winid: number, capacity: number, status: number) => number;
}

// null means "tried and unavailable" — the probe runs at most once either way.
let icu: Icu | null | undefined;

/** Load the system ICU once, lazily. Returns null when the host has no `icu.dll` (pre-1703 Windows). */
function getIcu(): Icu | null {
	if (icu === undefined) {
		try {
			const lib = dlopen('icu.dll', {
				ucal_getWindowsTimeZoneID: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
			});
			icu = lib.symbols as unknown as Icu;
		} catch {
			icu = null;
		}
	}
	return icu;
}

/** True when this host can convert IANA identifiers, i.e. when the timezone can be set at all. */
export function canConvertTimezoneId(): boolean {
	return getIcu() !== null;
}

/**
 * Convert an IANA timezone identifier to the Windows one `tzutil /s` expects.
 * Returns null when the host has no ICU or when CLDR knows no Windows equivalent
 * for that zone. Never throws.
 */
export function ianaToWindowsTimezoneId(timezone: string): string | null {
	const lib = getIcu();
	if (!lib) return null;
	try {
		const source = toUtf16(timezone);
		// Windows identifiers are short; 128 code units is far beyond the longest.
		const out = new Uint16Array(128);
		const status = new Int32Array(1);
		const length = lib.ucal_getWindowsTimeZoneID(ptr(source), source.length, ptr(out), out.length, ptr(status));
		// UErrorCode: negative values are warnings, positive ones are failures.
		if (status[0]! > 0 || length <= 0 || length > out.length) return null;
		return String.fromCharCode(...out.subarray(0, length));
	} catch {
		return null;
	}
}
