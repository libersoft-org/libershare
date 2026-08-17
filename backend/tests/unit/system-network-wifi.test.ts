import { describe, expect, it } from 'bun:test';
import { ptr, toArrayBuffer, type Pointer } from 'bun:ffi';
import { assertWindowsWifiKey, encodeConnectionParameters, findScannedNetwork, guidToBytes, parseAvailableNetworks, readStoredProfile, readUtf16z, utf16z, windowsWifiProfileXml, wlanErrorMessage, wlanScanErrorMessage } from '../../src/system-network-windows.ts';

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
	/** Windows' own name for the stored profile. Not the SSID, and often not equal to it. */
	profileName?: string;
	/** Raw SSID octets, for a name that is not valid UTF-8 and so has no text form. */
	ssidOctets?: number[];
	/** bNetworkConnectable. Real lists set this TRUE for anything joinable. */
	connectable?: boolean;
	/** wlanNotConnectableReason, meaningful only when connectable is false. */
	notConnectableReason?: number;
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
		const name = network.ssidOctets ? Uint8Array.from(network.ssidOctets) : new TextEncoder().encode(network.ssid);
		const profile = network.profileName ?? network.ssid;
		for (let i = 0; i < profile.length && i < 256; i++) view.setUint16(base + i * 2, profile.charCodeAt(i), true);
		view.setUint32(base + 512, network.ssidLength ?? name.length, true);
		bytes.set(name.subarray(0, 32), base + 516);
		view.setUint32(base + 556, network.connectable === false ? 0 : 1, true);
		view.setUint32(base + 560, network.notConnectableReason ?? 0, true);
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

	it('rejects a list whose declared count cannot be a scan result', () => {
		// A count of one million is what a wrong header offset or a stale pointer
		// produces. Clamping it to the cap and walking anyway read whatever followed
		// the allocation and reported it as networks; a structure that describes
		// itself impossibly is refused instead.
		const list = buildList([{ ssid: 'Only One', signal: 50 }], 1000000);
		expect(() => parseAvailableNetworks(list)).toThrow();
	});

	it('still accepts a count at the plausible limit', () => {
		// The refusal must be aimed at corruption, not at a merely busy radio.
		const list = buildList([{ ssid: 'Only One', signal: 50 }], 1);
		expect(parseAvailableNetworks(list).map(n => n.ssid)).toEqual(['Only One']);
	});

	it('returns nothing for an empty list', () => {
		expect(parseAvailableNetworks(buildList([]))).toEqual([]);
	});
});

describe('findScannedNetwork', () => {
	it('reports the algorithm Windows recorded for a network', () => {
		const list = buildList([
			{ ssid: 'Modern Net', signal: 70, auth: 9 },
			{ ssid: 'Older Net', signal: 70, auth: 7 },
		]);
		expect(findScannedNetwork(list, 'Modern Net')?.auth).toBe(9);
		expect(findScannedNetwork(list, 'Older Net')?.auth).toBe(7);
	});

	it('reports null for a name the list does not contain', () => {
		expect(findScannedNetwork(buildList([{ ssid: 'Present', signal: 70 }]), 'Absent')).toBeNull();
	});

	// Windows keeps the profile name and the SSID apart, and the profile name is
	// case-sensitive. Using the SSID as the profile name left an existing
	// custom-named profile unfound and unbacked-up, and created a second profile
	// competing with it.
	it('carries the profile name Windows itself uses, not the SSID', () => {
		const list = buildList([{ ssid: 'Coffee Bar', signal: 70, profileName: 'Work laptop - cafe' }]);
		expect(findScannedNetwork(list, 'Coffee Bar')?.profileName).toBe('Work laptop - cafe');
	});

	it('reports an empty profile name for a network nothing is stored for', () => {
		const list = buildList([{ ssid: 'Coffee Bar', signal: 70, profileName: '' }]);
		expect(findScannedNetwork(list, 'Coffee Bar')?.profileName).toBe('');
	});

	// An SSID is a byte sequence. The decoded text is lossy for anything that is
	// not UTF-8, so the bytes have to survive alongside it or the profile would
	// target a network built out of replacement characters.
	it('keeps the raw SSID octets beside the decoded text', () => {
		const octets = [0x4e, 0x65, 0x74, 0xff, 0xfe];
		const list = buildList([{ ssid: '', signal: 70, ssidOctets: octets, ssidLength: octets.length }]);
		const entry = findScannedNetwork(list, 'Net\uFFFD\uFFFD');
		expect(entry).not.toBeNull();
		expect([...(entry?.ssidBytes ?? [])]).toEqual(octets);
	});

	// Windows sets bNetworkConnectable FALSE when it already knows it cannot
	// associate — an unsupported cipher, a policy restriction. Attempting anyway
	// spent twenty seconds waiting and then blamed the password.
	it('carries the connectability verdict and the reason Windows gave for it', () => {
		const list = buildList([
			{ ssid: 'Enterprise Net', signal: 70, connectable: false, notConnectableReason: 0x00028001 },
			{ ssid: 'Coffee Bar', signal: 70 },
		]);
		expect(findScannedNetwork(list, 'Enterprise Net')?.connectable).toBe(false);
		expect(findScannedNetwork(list, 'Enterprise Net')?.notConnectableReason).toBe(0x00028001);
		expect(findScannedNetwork(list, 'Coffee Bar')?.connectable).toBe(true);
		expect(findScannedNetwork(list, 'Coffee Bar')?.notConnectableReason).toBe(0);
	});

	it('picks the strongest entry when one name is on several access points', () => {
		const list = buildList([
			{ ssid: 'Roaming Net', signal: 30, auth: 7 },
			{ ssid: 'Roaming Net', signal: 88, auth: 9 },
		]);
		expect(findScannedNetwork(list, 'Roaming Net')?.auth).toBe(9);
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

describe('windowsWifiProfileXml', () => {
	const bar = new TextEncoder().encode('Coffee Bar');
	const modern = new TextEncoder().encode('Modern Net');

	it('labels the profile with the profile name and the SSID with its octets', () => {
		const xml = windowsWifiProfileXml('Work laptop - cafe', bar, 'hunter2000');
		expect(xml).toContain('<name>Work laptop - cafe</name>');
		expect(xml).toContain('<SSIDConfig><SSID><hex>436F6666656520426172</hex></SSID></SSIDConfig>');
		expect(xml).toContain('xmlns="http://www.microsoft.com/networking/WLAN/profile/v1"');
	});

	// An SSID is not guaranteed to be UTF-8, and round-tripping it through text
	// replaces every undecodable octet with U+FFFD — so the profile would target a
	// network that does not exist. `<hex>` is the authoritative form.
	it('carries an SSID that has no valid text form byte for byte', () => {
		const xml = windowsWifiProfileXml('Odd Net', Uint8Array.from([0x4e, 0x65, 0x74, 0xff, 0xfe]), '');
		expect(xml).toContain('<hex>4E6574FFFE</hex>');
		expect(xml).not.toContain('\uFFFD');
	});

	it('never writes the SSID as text, which Windows would ignore anyway', () => {
		expect(windowsWifiProfileXml('Work laptop - cafe', bar, '')).not.toContain('<SSID><name>');
	});

	// The UI offers Connect and no "remember this network" choice, so an explicit
	// one-off join must not leave Windows re-associating with a guest or
	// conference network by itself afterwards — nor auto-joining an open network
	// of that name somewhere else entirely.
	it('joins once rather than saving a network to be auto-joined later', () => {
		for (const password of ['', 'hunter2000']) expect(windowsWifiProfileXml('Coffee Bar', bar, password)).toContain('<connectionMode>manual</connectionMode>');
		expect(windowsWifiProfileXml('Coffee Bar', bar, '')).not.toContain('<connectionMode>auto</connectionMode>');
	});

	it('builds a WPA2 personal profile carrying the passphrase', () => {
		const xml = windowsWifiProfileXml('Coffee Bar', bar, 'hunter2000');
		expect(xml).toContain('<authentication>WPA2PSK</authentication><encryption>AES</encryption>');
		expect(xml).toContain('<keyType>passPhrase</keyType><protected>false</protected><keyMaterial>hunter2000</keyMaterial>');
	});

	it('builds a WPA3 personal profile when the network uses SAE', () => {
		const xml = windowsWifiProfileXml('Modern Net', modern, 'hunter2000', true);
		expect(xml).toContain('<authentication>WPA3SAE</authentication><encryption>AES</encryption>');
		expect(xml).not.toContain('WPA2PSK');
	});

	it('declares a 64-hex credential as a raw network key, not a passphrase', () => {
		// Announced as passPhrase, Windows hashes an already-hashed key a second
		// time: the profile is accepted and then never authenticates.
		const xml = windowsWifiProfileXml('Modern Net', modern, 'a'.repeat(64));
		expect(xml).toContain('<keyType>networkKey</keyType>');
		expect(xml).not.toContain('passPhrase');
	});

	it('still declares an ordinary credential as a passphrase', () => {
		// 64 characters that are NOT all hex are a passphrase — but they are also
		// past the 63-character limit, so the ordinary case is a normal-length one.
		expect(windowsWifiProfileXml('Coffee Bar', bar, 'hunter2000')).toContain('<keyType>passPhrase</keyType>');
		expect(windowsWifiProfileXml('Coffee Bar', bar, `${'a'.repeat(63)}z`)).toContain('<keyType>passPhrase</keyType>');
	});

	it('builds an open profile with no key when there is no password', () => {
		const xml = windowsWifiProfileXml('Open Guest Net', new TextEncoder().encode('Open Guest Net'), '');
		expect(xml).toContain('<authentication>open</authentication><encryption>none</encryption>');
		expect(xml).not.toContain('sharedKey');
	});

	// Negative control: an SSID or a passphrase containing XML metacharacters must
	// not be able to close a tag, which would either corrupt the profile or make it
	// describe a different network than the user picked.
	it('escapes XML metacharacters in the name and the key', () => {
		const xml = windowsWifiProfileXml('A & B <net>', new TextEncoder().encode('A & B <net>'), 'p"a\'ss<');
		expect(xml).toContain('<name>A &amp; B &lt;net&gt;</name>');
		expect(xml).toContain('<keyMaterial>p&quot;a&apos;ss&lt;</keyMaterial>');
		expect(xml).not.toContain('<net>');
	});
});

/**
 * On Windows the profile is written to disk BEFORE the association is attempted,
 * so a credential that could never work replaces a saved network's real one on
 * its way to failing. These are the two constraints the shared validator cannot
 * apply, because only this module knows which mechanism the access point runs
 * and which subset of 802.11i the Microsoft profile schema accepts.
 */
describe('assertWindowsWifiKey', () => {
	it('accepts an ordinary printable passphrase under either mechanism', () => {
		for (const sae of [false, true]) expect(() => assertWindowsWifiKey('hunter2000', sae)).not.toThrow();
	});

	it('accepts a raw 64-hex key only where WPA2 is in use', () => {
		const psk = '0123456789abcdef'.repeat(4);
		expect(() => assertWindowsWifiKey(psk, false)).not.toThrow();
		// SAE derives its key from a passphrase: announced as key material it is
		// written, accepted, and then never authenticates.
		expect(() => assertWindowsWifiKey(psk, true)).toThrow('WPA3');
	});

	it('refuses a passphrase Windows cannot express in its profile schema', () => {
		// `passPhrase` key material is 8-63 PRINTABLE ASCII. Anything else comes back
		// from WlanSetProfile as an opaque reason code, after the overwrite.
		expect(() => assertWindowsWifiKey('heslíčko123', false)).toThrow('printable ASCII');
		expect(() => assertWindowsWifiKey('pass word', false)).not.toThrow();
	});

	it('refuses a passphrase of the wrong length before anything is written', () => {
		for (const key of ['short', 'x'.repeat(64)]) expect(() => assertWindowsWifiKey(key, false)).toThrow();
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

/**
 * A WlanApi whose WlanGetProfile answers one canned outcome, writing into the
 * caller's out-parameters exactly as the real one does. Only the two entry points
 * {@link readStoredProfile} uses are provided; anything else reaching this stub
 * would be a call the function has no business making.
 */
function getProfileApi(rc: number, xml: string | null, flags: number = 0): Parameters<typeof readStoredProfile>[0] {
	const document = xml === null ? null : utf16z(xml);
	if (document) retainedProfiles.push(document);
	return {
		WlanGetProfile: (_handle: bigint, _guid: Pointer, _name: Pointer, _reserved: null, xmlOut: Pointer, flagsOut: Pointer) => {
			new BigUint64Array(toArrayBuffer(xmlOut, 0, 8))[0] = document ? BigInt(ptr(document)) : 0n;
			new Uint32Array(toArrayBuffer(flagsOut, 0, 4))[0] = flags;
			return rc;
		},
		// The stub owns its buffer, so freeing is a no-op — but it must exist, since
		// a real read frees the document whichever way it ends.
		WlanFreeMemory: () => {},
	} as unknown as Parameters<typeof readStoredProfile>[0];
}

/** Profile documents must outlive the pointers handed back through the out-parameter. */
const retainedProfiles: Uint16Array[] = [];

const ANY_GUID = guidToBytes('{11111111-2222-3333-4444-555555555555}');

describe('readStoredProfile', () => {
	it('reports a stored profile with the flags Windows gave it', () => {
		const result = readStoredProfile(getProfileApi(0, '<WLANProfile/>', 2), 1n, ANY_GUID, 'Example');
		expect(result).toEqual({ kind: 'found', profile: { xml: '<WLANProfile/>', flags: 2 } });
	});

	// The one code that really means "Windows holds nothing under this name".
	it('reports a genuine absence for ERROR_NOT_FOUND', () => {
		expect(readStoredProfile(getProfileApi(1168, null), 1n, ANY_GUID, 'Example')).toEqual({ kind: 'notFound' });
	});

	// The regression this union exists for: every one of these used to read as
	// "no profile existed", which let the join overwrite a profile with no backup
	// and the rollback then delete it.
	it.each([
		[5, 'access denied'],
		[6, 'an invalid handle'],
		[8, 'out of memory'],
		[1727, 'an RPC failure'],
	])('reports code %i (%s) as an error, never as an absence', code => {
		const result = readStoredProfile(getProfileApi(code, null), 1n, ANY_GUID, 'Example');
		expect(result.kind).toBe('error');
	});

	// A success that hands back no document leaves nothing to restore from, which
	// is the same hazard by another route.
	it('refuses a success that returned no document', () => {
		const result = readStoredProfile(getProfileApi(0, null), 1n, ANY_GUID, 'Example');
		expect(result.kind).toBe('error');
	});
});
