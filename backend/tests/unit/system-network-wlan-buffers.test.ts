import { describe, expect, it } from 'bun:test';
import { ptr, type Pointer } from 'bun:ffi';
import { guidToBytes, readUtf16z, utf16z, encodeConnectionParameters, wlanErrorMessage, wlanScanErrorMessage } from '../../src/system-network-windows.ts';

describe('guidToBytes', () => {
	it('lays the first three fields out little-endian and the rest as written', () => {
		expect([...guidToBytes('{00112233-4455-6677-8899-AABBCCDDEEFF}')]).toEqual([0x33, 0x22, 0x11, 0x00, 0x55, 0x44, 0x77, 0x66, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
	});

	it('accepts the lowercase form Windows sometimes prints', () => {
		expect(guidToBytes('{00112233-4455-6677-8899-aabbccddeeff}')).toEqual(guidToBytes('{00112233-4455-6677-8899-AABBCCDDEEFF}'));
	});

	// Negative control: a malformed id must never be turned into some other
	// adapter's GUID, because a scan or a join would then address the wrong radio.
	it('refuses anything that is not a braced GUID', () => {
		for (const bad of ['', 'wlan0', '00112233-4455-6677-8899-AABBCCDDEEFF', '{00112233-4455-6677-8899-AABBCCDDEEF}', '{zz112233-4455-6677-8899-AABBCCDDEEFF}']) {
			expect(() => guidToBytes(bad)).toThrow();
		}
	});
});

describe('readUtf16z', () => {
	// The profile document is handed back as a pointer Windows allocated, so the
	// reader has to find its own end — a restore writes back exactly what it read.
	function widePointer(text: string, extra = 8): Pointer {
		const buffer = new Uint16Array(text.length + extra);
		for (let i = 0; i < text.length; i++) buffer[i] = text.charCodeAt(i);
		return ptr(buffer);
	}

	it('reads back exactly what utf16z wrote', () => {
		const profile = '<?xml version="1.0"?><WLANProfile><name>Example Net</name></WLANProfile>';
		expect(readUtf16z(ptr(utf16z(profile)))).toBe(profile);
	});

	it('stops at the terminator and ignores what follows', () => {
		expect(readUtf16z(widePointer('abc'))).toBe('abc');
	});

	it('fails loudly when there is no terminator at all', () => {
		// Silently returning the first `maxChars` was the dangerous outcome: the
		// document exists to be handed straight back to WlanSetProfile, and a
		// truncated profile is not a smaller profile but a malformed one — which
		// would then replace a working network's saved configuration.
		const buffer = new Uint16Array(4).fill(0x41);
		expect(() => readUtf16z(ptr(buffer), 4)).toThrow();
	});

	it('reads a document longer than the first mapped block', () => {
		// The reader maps in growing blocks so the ordinary case never maps far past
		// the allocation; a profile past the first block must still come back whole.
		const long = `<WLANProfile>${'x'.repeat(3000)}</WLANProfile>`;
		expect(readUtf16z(ptr(utf16z(long)))).toBe(long);
	});

	it('reads an empty document as an empty string', () => {
		expect(readUtf16z(ptr(utf16z('')))).toBe('');
	});
});

describe('utf16z', () => {
	it('encodes as UTF-16 code units and terminates with NUL', () => {
		expect([...utf16z('Hi')]).toEqual([0x48, 0x69, 0]);
	});

	it('keeps a non-ASCII character as one code unit', () => {
		expect([...utf16z('á')]).toEqual([0xe1, 0]);
	});

	it('encodes an empty string as a lone terminator', () => {
		expect([...utf16z('')]).toEqual([0]);
	});
});

describe('encodeConnectionParameters', () => {
	it('places the mode, the profile pointer and the BSS type where wlanapi expects them', () => {
		const bytes = encodeConnectionParameters(0x1122334455667788n);
		const view = new DataView(bytes.buffer);
		expect(bytes.length).toBe(40);
		// wlan_connection_mode_profile, then 4 bytes of padding before the pointer.
		expect(view.getUint32(0, true)).toBe(0);
		expect(view.getUint32(4, true)).toBe(0);
		expect(view.getBigUint64(8, true)).toBe(0x1122334455667788n);
		// pDot11Ssid and pDesiredBssidList are both NULL for a connect-by-profile.
		expect(view.getBigUint64(16, true)).toBe(0n);
		expect(view.getBigUint64(24, true)).toBe(0n);
		// dot11_BSS_type_infrastructure, and no flags.
		expect(view.getUint32(32, true)).toBe(1);
		expect(view.getUint32(36, true)).toBe(0);
	});
});

describe('wlanErrorMessage', () => {
	it('explains the codes these calls actually return', () => {
		expect(wlanErrorMessage(5)).toBe('access denied by Windows');
		expect(wlanErrorMessage(1168)).toBe('Windows found no matching interface or saved profile');
		expect(wlanErrorMessage(2150899714)).toBe('the Wi-Fi radio is switched off');
	});

	// Negative control: an unrecognized code keeps its number rather than being
	// described as something it might not be.
	it('falls back to the raw code rather than guessing', () => {
		expect(wlanErrorMessage(0x1234)).toBe('Wi-Fi error 0x1234');
	});
});

describe('wlanScanErrorMessage', () => {
	it('names the location permission for a refused scan', () => {
		// Windows gates the available-network APIs on location access, so plain
		// "access denied" would send the user hunting for a privilege problem.
		expect(wlanScanErrorMessage(5)).toContain('location');
	});

	it('leaves every other code with its ordinary description', () => {
		expect(wlanScanErrorMessage(1062)).toBe(wlanErrorMessage(1062));
		expect(wlanScanErrorMessage(2150899714)).toBe('the Wi-Fi radio is switched off');
	});
});
