import { describe, expect, it } from 'bun:test';
import { ptr, type Pointer } from 'bun:ffi';
import { encodeConnectionParameters, findAuthAlgorithm, guidToBytes, parseAvailableNetworks, readUtf16z, utf16z, windowsWifiProfileXml, wlanErrorMessage, wlanScanErrorMessage } from '../../src/system-network-windows.ts';

/**
 * The Windows Wi-Fi surface is FFI, so most of what can go wrong is a struct
 * offset. These cases build buffers with the layout wlanapi.h documents — the
 * same layout a live WLAN_AVAILABLE_NETWORK_LIST was decoded against on a
 * Windows 11 workstation — and check both that a well-formed one reads correctly
 * and that a malformed one is refused instead of yielding plausible nonsense.
 *
 * SSIDs here are invented; no real network name appears in this repository.
 */

/** WLAN_AVAILABLE_NETWORK, x64. */
const NETWORK_SIZE = 628;
const LIST_HEADER = 8;

interface NetworkFields {
	ssid: string;
	signal: number;
	secured?: boolean;
	active?: boolean;
	auth?: number;
	/** Overrides the SSID's own byte length — used to forge an impossible one. */
	ssidLength?: number;
}

/** Buffers must outlive the pointers handed to the decoder, so every one is retained. */
const retained: Uint8Array[] = [];

/** Build a WLAN_AVAILABLE_NETWORK_LIST holding the given networks. */
function buildList(networks: NetworkFields[], declaredCount: number = networks.length): Pointer {
	const bytes = new Uint8Array(LIST_HEADER + networks.length * NETWORK_SIZE);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, declaredCount, true);
	view.setUint32(4, 0, true);
	networks.forEach((network, index) => {
		const base = LIST_HEADER + index * NETWORK_SIZE;
		const name = new TextEncoder().encode(network.ssid);
		view.setUint32(base + 512, network.ssidLength ?? name.length, true);
		bytes.set(name.subarray(0, 32), base + 516);
		view.setUint32(base + 604, network.signal, true);
		view.setUint32(base + 608, network.secured === false ? 0 : 1, true);
		view.setUint32(base + 612, network.auth ?? 7, true);
		view.setUint32(base + 620, network.active ? 1 : 0, true);
	});
	retained.push(bytes);
	return ptr(bytes);
}

describe('parseAvailableNetworks', () => {
	it('decodes name, signal, security and the connected flag', () => {
		const list = buildList([
			{ ssid: 'Coffee Bar', signal: 71, active: true },
			{ ssid: 'Open Guest Net', signal: 40, secured: false },
		]);
		expect(parseAvailableNetworks(list)).toEqual([
			{ ssid: 'Coffee Bar', signal: 71, secured: true, active: true },
			{ ssid: 'Open Guest Net', signal: 40, secured: false, active: false },
		]);
	});

	it('sorts strongest first regardless of the order Windows returned', () => {
		const list = buildList([
			{ ssid: 'Weak', signal: 12 },
			{ ssid: 'Strong', signal: 95 },
			{ ssid: 'Middling', signal: 55 },
		]);
		expect(parseAvailableNetworks(list).map(n => n.ssid)).toEqual(['Strong', 'Middling', 'Weak']);
	});

	it('collapses one name seen on several access points to the strongest reading', () => {
		const list = buildList([
			{ ssid: 'Roaming Net', signal: 30 },
			{ ssid: 'Roaming Net', signal: 88 },
			{ ssid: 'Roaming Net', signal: 61 },
		]);
		expect(parseAvailableNetworks(list)).toEqual([{ ssid: 'Roaming Net', signal: 88, secured: true, active: false }]);
	});

	it('keeps the connected flag when the associated entry is not the strongest one', () => {
		const list = buildList([
			{ ssid: 'Roaming Net', signal: 30, active: true },
			{ ssid: 'Roaming Net', signal: 88 },
		]);
		expect(parseAvailableNetworks(list)[0]).toEqual({ ssid: 'Roaming Net', signal: 88, secured: true, active: true });
		const reversed = buildList([
			{ ssid: 'Roaming Net', signal: 88 },
			{ ssid: 'Roaming Net', signal: 30, active: true },
		]);
		expect(parseAvailableNetworks(reversed)[0]).toEqual({ ssid: 'Roaming Net', signal: 88, secured: true, active: true });
	});

	it('drops a hidden network, which has no name to join by', () => {
		const list = buildList([
			{ ssid: '', signal: 80 },
			{ ssid: 'Named Net', signal: 20 },
		]);
		expect(parseAvailableNetworks(list).map(n => n.ssid)).toEqual(['Named Net']);
	});

	it('decodes a non-ASCII name from its UTF-8 octets', () => {
		const list = buildList([{ ssid: 'Kavárna Přízemí', signal: 66 }]);
		expect(parseAvailableNetworks(list)[0]?.ssid).toBe('Kavárna Přízemí');
	});

	// Negative controls: a wrong offset shows up as an impossible field value, and
	// the decoder must drop such an entry rather than report a believable lie.
	it('drops an entry whose signal cannot be a percentage', () => {
		const list = buildList([
			{ ssid: 'Broken', signal: 4294967295 },
			{ ssid: 'Sane', signal: 50 },
		]);
		expect(parseAvailableNetworks(list).map(n => n.ssid)).toEqual(['Sane']);
	});

	it('drops an entry whose SSID length exceeds what DOT11_SSID can hold', () => {
		const list = buildList([
			{ ssid: 'Broken', signal: 50, ssidLength: 99 },
			{ ssid: 'Sane', signal: 50 },
		]);
		expect(parseAvailableNetworks(list).map(n => n.ssid)).toEqual(['Sane']);
	});

	it('refuses to walk past the entries the buffer actually holds', () => {
		// A count of one million is what a wrong header offset would produce; the cap
		// keeps the walk bounded instead of reading unrelated memory.
		const list = buildList([{ ssid: 'Only One', signal: 50 }], 1000000);
		expect(() => parseAvailableNetworks(list)).not.toThrow();
	});

	it('returns nothing for an empty list', () => {
		expect(parseAvailableNetworks(buildList([]))).toEqual([]);
	});
});

describe('findAuthAlgorithm', () => {
	it('reports the algorithm Windows recorded for a network', () => {
		const list = buildList([
			{ ssid: 'Modern Net', signal: 70, auth: 9 },
			{ ssid: 'Older Net', signal: 70, auth: 7 },
		]);
		expect(findAuthAlgorithm(list, 'Modern Net')).toBe(9);
		expect(findAuthAlgorithm(list, 'Older Net')).toBe(7);
	});

	it('reports null for a name the list does not contain', () => {
		expect(findAuthAlgorithm(buildList([{ ssid: 'Present', signal: 70 }]), 'Absent')).toBeNull();
	});
});

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

	it('stops at the cap when there is no terminator at all', () => {
		const buffer = new Uint16Array(4).fill(0x41);
		expect(readUtf16z(ptr(buffer), 4)).toBe('AAAA');
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

describe('windowsWifiProfileXml', () => {
	it('names the network in both places Windows reads it from', () => {
		const xml = windowsWifiProfileXml('Coffee Bar', 'hunter2000');
		expect(xml).toContain('<name>Coffee Bar</name><SSIDConfig><SSID><name>Coffee Bar</name></SSID></SSIDConfig>');
		expect(xml).toContain('xmlns="http://www.microsoft.com/networking/WLAN/profile/v1"');
	});

	it('builds a WPA2 personal profile carrying the passphrase', () => {
		const xml = windowsWifiProfileXml('Coffee Bar', 'hunter2000');
		expect(xml).toContain('<authentication>WPA2PSK</authentication><encryption>AES</encryption>');
		expect(xml).toContain('<keyType>passPhrase</keyType><protected>false</protected><keyMaterial>hunter2000</keyMaterial>');
	});

	it('builds a WPA3 personal profile when the network uses SAE', () => {
		const xml = windowsWifiProfileXml('Modern Net', 'hunter2000', true);
		expect(xml).toContain('<authentication>WPA3SAE</authentication><encryption>AES</encryption>');
		expect(xml).not.toContain('WPA2PSK');
	});

	it('declares a 64-hex credential as a raw network key, not a passphrase', () => {
		// Announced as passPhrase, Windows hashes an already-hashed key a second
		// time: the profile is accepted and then never authenticates.
		const xml = windowsWifiProfileXml('Modern Net', 'a'.repeat(64));
		expect(xml).toContain('<keyType>networkKey</keyType>');
		expect(xml).not.toContain('passPhrase');
	});

	it('still declares an ordinary credential as a passphrase', () => {
		// 64 characters that are NOT all hex are a passphrase — but they are also
		// past the 63-character limit, so the ordinary case is a normal-length one.
		expect(windowsWifiProfileXml('Coffee Bar', 'hunter2000')).toContain('<keyType>passPhrase</keyType>');
		expect(windowsWifiProfileXml('Coffee Bar', `${'a'.repeat(63)}z`)).toContain('<keyType>passPhrase</keyType>');
	});

	it('builds an open profile with no key when there is no password', () => {
		const xml = windowsWifiProfileXml('Open Guest Net', '');
		expect(xml).toContain('<authentication>open</authentication><encryption>none</encryption>');
		expect(xml).not.toContain('sharedKey');
	});

	// Negative control: an SSID or a passphrase containing XML metacharacters must
	// not be able to close a tag, which would either corrupt the profile or make it
	// describe a different network than the user picked.
	it('escapes XML metacharacters in the name and the key', () => {
		const xml = windowsWifiProfileXml('A & B <net>', 'p"a\'ss<');
		expect(xml).toContain('<name>A &amp; B &lt;net&gt;</name>');
		expect(xml).toContain('<keyMaterial>p&quot;a&apos;ss&lt;</keyMaterial>');
		expect(xml).not.toContain('<net>');
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
