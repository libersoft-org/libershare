import { describe, expect, it } from 'bun:test';
import { ptr, toArrayBuffer, type Pointer } from 'bun:ffi';
import { assertProfileNameWritable, assertWindowsWifiKey, type AvailableNetwork, openJoinDecision, withJoinCredentials, type JoinTarget, encodeConnectionParameters, findScannedNetwork, guidToBytes, parseAvailableNetworks, readStoredProfile, readUtf16z, undoProfileChange, writeJoinProfile, utf16z, windowsWifiProfileXml, wlanErrorMessage, wlanScanErrorMessage } from '../../src/system-network-windows.ts';

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

/** The one network a lookup found, or null — an ambiguous answer is a test failure here. */
function onlyMatch(found: ReturnType<typeof findScannedNetwork>): AvailableNetwork | null {
	expect(found).not.toBe('ambiguous');
	return found === 'ambiguous' ? null : found;
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
			{ ssid: 'Coffee Bar', bssid: null, signal: 71, secured: true, security: 'WPA2', supported: true, active: true },
			{ ssid: 'Open Guest Net', bssid: null, signal: 40, secured: false, security: '', supported: false, active: false },
		]);
	});

	it('takes every security field from one row, whatever order Windows listed them in', () => {
		// Two access points answering to one name can advertise different security.
		// Merging them field by field produced a reading no access point gave: an open
		// row beside a WPA2 row yielded `secured` from one and `security` from the
		// other, so the form asked for a password the profile then declared open — and
		// which answer came out depended on the listing order alone.
		const wpaFirst = parseAvailableNetworks(
			buildList([
				{ ssid: 'Guest', signal: 40, secured: true, auth: 7 },
				{ ssid: 'Guest', signal: 80, secured: false, auth: 1 },
			])
		);
		const openFirst = parseAvailableNetworks(
			buildList([
				{ ssid: 'Guest', signal: 80, secured: false, auth: 1 },
				{ ssid: 'Guest', signal: 40, secured: true, auth: 7 },
			])
		);
		expect(wpaFirst).toEqual(openFirst);
		// And the surviving row is the strongest one, described consistently.
		expect(wpaFirst[0]).toMatchObject({ ssid: 'Guest', signal: 80, secured: false, security: '' });
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
		expect(parseAvailableNetworks(list)).toEqual([{ ssid: 'Roaming Net', bssid: null, signal: 88, secured: true, security: 'WPA2', supported: true, active: false }]);
	});

	it('keeps the connected flag when the associated entry is not the strongest one', () => {
		const list = buildList([
			{ ssid: 'Roaming Net', signal: 30, active: true },
			{ ssid: 'Roaming Net', signal: 88 },
		]);
		expect(parseAvailableNetworks(list)[0]).toEqual({ ssid: 'Roaming Net', bssid: null, signal: 88, secured: true, security: 'WPA2', supported: true, active: true });
		const reversed = buildList([
			{ ssid: 'Roaming Net', signal: 88 },
			{ ssid: 'Roaming Net', signal: 30, active: true },
		]);
		expect(parseAvailableNetworks(reversed)[0]).toEqual({ ssid: 'Roaming Net', bssid: null, signal: 88, secured: true, security: 'WPA2', supported: true, active: true });
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
	it('refuses a name two different networks decode to', () => {
		// `Café` and `Cafè` are two DIFFERENT SSIDs that both display as `Caf`
		// plus a replacement character. Picking the stronger of them joined whichever
		// happened to be closer at that instant, and the answer flipped between the
		// list the user saw and the join that followed.
		const a = [0x43, 0x61, 0x66, 0xe9];
		const b = [0x43, 0x61, 0x66, 0xe8];
		const name = new TextDecoder().decode(Uint8Array.from(a));
		expect(
			findScannedNetwork(
				buildList([
					{ ssid: name, ssidOctets: a, signal: 40 },
					{ ssid: name, ssidOctets: b, signal: 80 },
				]),
				name
			)
		).toBe('ambiguous');
		expect(
			findScannedNetwork(
				buildList([
					{ ssid: name, ssidOctets: b, signal: 80 },
					{ ssid: name, ssidOctets: a, signal: 40 },
				]),
				name
			)
		).toBe('ambiguous');
	});

	it('still picks the strongest access point of ONE network', () => {
		const rows = [
			{ ssid: 'Roaming', signal: 30 },
			{ ssid: 'Roaming', signal: 88 },
		];
		expect(onlyMatch(findScannedNetwork(buildList(rows), 'Roaming'))?.signal).toBe(88);
	});
	it('reports the algorithm Windows recorded for a network', () => {
		const list = buildList([
			{ ssid: 'Modern Net', signal: 70, auth: 9 },
			{ ssid: 'Older Net', signal: 70, auth: 7 },
		]);
		expect(onlyMatch(findScannedNetwork(list, 'Modern Net'))?.auth).toBe(9);
		expect(onlyMatch(findScannedNetwork(list, 'Older Net'))?.auth).toBe(7);
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
		expect(onlyMatch(findScannedNetwork(list, 'Coffee Bar'))?.profileName).toBe('Work laptop - cafe');
	});

	it('reports an empty profile name for a network nothing is stored for', () => {
		const list = buildList([{ ssid: 'Coffee Bar', signal: 70, profileName: '' }]);
		expect(onlyMatch(findScannedNetwork(list, 'Coffee Bar'))?.profileName).toBe('');
	});

	// An SSID is a byte sequence. The decoded text is lossy for anything that is
	// not UTF-8, so the bytes have to survive alongside it or the profile would
	// target a network built out of replacement characters.
	it('keeps the raw SSID octets beside the decoded text', () => {
		const octets = [0x4e, 0x65, 0x74, 0xff, 0xfe];
		const list = buildList([{ ssid: '', signal: 70, ssidOctets: octets, ssidLength: octets.length }]);
		const entry = onlyMatch(findScannedNetwork(list, 'Net\uFFFD\uFFFD'));
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
		expect(onlyMatch(findScannedNetwork(list, 'Enterprise Net'))?.connectable).toBe(false);
		expect(onlyMatch(findScannedNetwork(list, 'Enterprise Net'))?.notConnectableReason).toBe(0x00028001);
		expect(onlyMatch(findScannedNetwork(list, 'Coffee Bar'))?.connectable).toBe(true);
		expect(onlyMatch(findScannedNetwork(list, 'Coffee Bar'))?.notConnectableReason).toBe(0);
	});

	it('picks the strongest entry when one name is on several access points', () => {
		const list = buildList([
			{ ssid: 'Roaming Net', signal: 30, auth: 7 },
			{ ssid: 'Roaming Net', signal: 88, auth: 9 },
		]);
		expect(onlyMatch(findScannedNetwork(list, 'Roaming Net'))?.auth).toBe(9);
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

describe('assertProfileNameWritable', () => {
	it('refuses only what a profile document cannot carry', () => {
		expect(() => assertProfileNameWritable('Bubu & Dudu')).not.toThrow();
		expect(() => assertProfileNameWritable('tab	here')).not.toThrow();
		// The shared gate lets this through, because NetworkManager joins it happily;
		// it is XML that cannot carry it, so it is refused here and nowhere else.
		expect(() => assertProfileNameWritable('Net')).toThrow(/cannot store/);
	});
});

describe('openJoinDecision', () => {
	const SSID = '4578616D706C65';
	const mine = { kind: 'found' as const, profile: { xml: `<WLANProfile><SSIDConfig><SSID><hex>${SSID}</hex></SSID></SSIDConfig></WLANProfile>`, flags: 2, customUserData: null } };
	const theirs = { kind: 'found' as const, profile: { xml: '<WLANProfile><SSIDConfig><SSID><hex>4F7468657231</hex></SSID></SSIDConfig></WLANProfile>', flags: 2, customUserData: null } };
	const target: JoinTarget = { ssidHex: SSID, password: '', sae: false, newProfile: () => '<WLANProfile/>' };

	it('uses a stored profile that really belongs to this network', () => {
		expect(openJoinDecision(mine, target)).toBe('connect');
	});

	it('refuses one of the same name that belongs to another network', () => {
		// This is the open-network branch, where nothing is written — so nothing is
		// rolled back either. `WlanConnect` takes the networks from the profile it is
		// handed, so using this one would associate the machine with the OTHER
		// network and leave it there.
		expect(() => openJoinDecision(theirs, target)).toThrow(/a different network is already saved under this name/);
	});

	it('creates one when the name is genuinely free', () => {
		expect(openJoinDecision({ kind: 'notFound' }, target)).toBe('create');
	});

	it('refuses a profile it could not read rather than guessing', () => {
		// Not the same as absent: writing here would replace a profile with no backup.
		expect(() => openJoinDecision({ kind: 'error', message: 'access denied by Windows' }, target)).toThrow(/could not be read/);
	});
});

describe('withJoinCredentials', () => {
	/** A stored WPA2 profile carrying settings that live INSIDE the security element. */
	const wpa2 = '<WLANProfile><MSM><security><authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption><sharedKey><keyType>passPhrase</keyType><keyMaterial>OLD</keyMaterial></sharedKey><FIPSMode>true</FIPSMode><PMKCacheMode>enabled</PMKCacheMode></security></MSM></WLANProfile>';
	const openProfile = '<WLANProfile><MSM><security><authEncryption><authentication>open</authentication><encryption>none</encryption><useOneX>false</useOneX></authEncryption><FIPSMode>true</FIPSMode></security></MSM></WLANProfile>';

	/** The key material as stored, with the five XML entities turned back. */
	function storedKey(xml: string): string {
		const raw = xml.match(/<keyMaterial>([\s\S]*?)<\/keyMaterial>/)?.[1] ?? '';
		return raw.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name] as string);
	}

	it('writes the password exactly as typed, dollars and all', () => {
		// `String.replace` reads `$$`, `$&`, `$'` and a dollar-backtick in the
		// REPLACEMENT as substitution syntax. A password containing one was rewritten
		// on its way into the profile — `Heslo$$123` was stored as `Heslo$123`, and
		// `$&` pasted the whole matched element into the key. The user then typed the
		// right password and Windows refused it.
		for (const password of ['Heslo$$123', 'a$&b', "c$'d", 'e$`f', 'p<&>"x', 'plain123']) {
			expect(storedKey(withJoinCredentials(wpa2, password, false) as string)).toBe(password);
		}
	});

	it('keeps the settings that live beside the key inside the security element', () => {
		// Replacing the whole `<security>` element preserved the profile around it and
		// still dropped what was inside — FIPSMode is a security setting, not noise.
		const edited = withJoinCredentials(wpa2, 'nove-heslo', false) as string;
		expect(edited).toContain('<FIPSMode>true</FIPSMode>');
		expect(edited).toContain('<PMKCacheMode>enabled</PMKCacheMode>');
		expect(edited).toContain('<useOneX>false</useOneX>');
		expect(edited).not.toContain('OLD');
	});

	it('moves a profile between the methods a join can need, keeping the rest', () => {
		expect(withJoinCredentials(wpa2, 'x'.repeat(10), true)).toContain('<authentication>WPA3SAE</authentication>');
		// An open profile has no key element to replace, so the new one is inserted.
		const secured = withJoinCredentials(openProfile, 'heslo1234', false) as string;
		expect(secured).toContain('<authentication>WPA2PSK</authentication>');
		expect(secured).toContain('<keyMaterial>heslo1234</keyMaterial>');
		expect(secured).toContain('<FIPSMode>true</FIPSMode>');
		// And back: no password means no key element at all.
		const opened = withJoinCredentials(wpa2, '', false) as string;
		expect(opened).toContain('<authentication>open</authentication>');
		expect(opened).not.toContain('<sharedKey>');
		expect(opened).toContain('<FIPSMode>true</FIPSMode>');
	});

	it('refuses a document that is not shaped like one Windows hands back', () => {
		expect(withJoinCredentials('<WLANProfile/>', 'x', false)).toBeNull();
		expect(withJoinCredentials('<WLANProfile><MSM><security></security></MSM></WLANProfile>', 'x', false)).toBeNull();
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

	it('refuses a passphrase of the wrong length under BOTH mechanisms', () => {
		// The shared validator holds WPA3 to no length at all, because NetworkManager
		// does not — measured. The Windows profile schema does, so the boundary is
		// checked here for SAE as much as for PSK; letting a 5-character WPA3 key
		// through only moved the refusal to an opaque WlanSetProfile reason code.
		for (const sae of [false, true]) {
			for (const key of ['', 'x', 'x'.repeat(7), 'x'.repeat(64), 'x'.repeat(100)]) expect(() => assertWindowsWifiKey(key, sae)).toThrow();
			for (const key of ['x'.repeat(8), 'x'.repeat(63)]) expect(() => assertWindowsWifiKey(key, sae)).not.toThrow();
		}
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
 * caller's out-parameters exactly as the real one does. Only the entry points
 * {@link readStoredProfile} uses are provided; anything else reaching this stub
 * would be a call the function has no business making.
 */
function getProfileApi(rc: number, xml: string | null, flags: number = 0, custom: string | null = null, customRc: number | null = null): Parameters<typeof readStoredProfile>[0] {
	const document = xml === null ? null : utf16z(xml);
	if (document) retainedProfiles.push(document);
	return {
		WlanGetProfile: (_handle: bigint, _guid: Pointer, _name: Pointer, _reserved: null, xmlOut: Pointer, flagsOut: Pointer) => {
			new BigUint64Array(toArrayBuffer(xmlOut, 0, 8))[0] = document ? BigInt(ptr(document)) : 0n;
			new Uint32Array(toArrayBuffer(flagsOut, 0, 4))[0] = flags;
			return rc;
		},
		WlanGetProfileCustomUserData: (_handle: bigint, _guid: Pointer, _name: Pointer, _reserved: null, sizeOut: Pointer, dataOut: Pointer) => {
			if (customRc !== null) return customRc;
			// ERROR_FILE_NOT_FOUND — what a profile with no custom data answers.
			if (custom === null) return 2;
			const blob = new TextEncoder().encode(custom);
			retainedBlobs.push(blob);
			new Uint32Array(toArrayBuffer(sizeOut, 0, 4))[0] = blob.length;
			new BigUint64Array(toArrayBuffer(dataOut, 0, 8))[0] = BigInt(ptr(blob));
			return 0;
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
		expect(result).toEqual({ kind: 'found', profile: { xml: '<WLANProfile/>', flags: 2, customUserData: null } });
	});

	// Windows keeps this blob separately from the document and discards it whenever
	// the document is rewritten with different content — which every join does,
	// because it writes the key the user just typed. Verified on Windows 11: an
	// identical WlanSetProfile leaves it, a changed one drops it. It belongs to
	// whichever WLAN client or provisioning tool wrote it and cannot be
	// reconstructed here, so it has to be snapshotted before it is destroyed.
	it('reports the custom user data another client keeps beside a profile', () => {
		const result = readStoredProfile(getProfileApi(0, '<WLANProfile/>', 2, 'vendor-metadata'), 1n, ANY_GUID, 'Example');
		expect(result.kind).toBe('found');
		expect(new TextDecoder().decode((result as { profile: { customUserData: Uint8Array } }).profile.customUserData)).toBe('vendor-metadata');
	});

	// The one code that really means "Windows holds nothing under this name".
	it('reports a genuine absence for ERROR_NOT_FOUND', () => {
		expect(readStoredProfile(getProfileApi(1168, null), 1n, ANY_GUID, 'Example')).toEqual({ kind: 'notFound' });
	});

	// ERROR_FILE_NOT_FOUND is the only code that means the profile HAS no custom data.
	it('reports no custom data for ERROR_FILE_NOT_FOUND', () => {
		expect(readStoredProfile(getProfileApi(0, '<WLANProfile/>', 2, null, 2), 1n, ANY_GUID, 'Example')).toEqual({ kind: 'found', profile: { xml: '<WLANProfile/>', flags: 2, customUserData: null } });
	});

	// Every other code used to read as "there is none", so the caller overwrote the
	// profile and destroyed a blob it had no copy of, then called the join a success.
	it.each([
		[6, 'an invalid handle'],
		[87, 'an invalid parameter'],
		[1727, 'an RPC failure'],
	])('refuses the whole reading when custom data fails with code %i (%s)', code => {
		const result = readStoredProfile(getProfileApi(0, '<WLANProfile/>', 2, null, code), 1n, ANY_GUID, 'Example');
		expect(result.kind).toBe('error');
		expect((result as { message: string }).message).toContain('another program stores with this network');
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

/** One scripted WlanGetProfile answer: a Win32 code, the document, its flags, and any custom user data. */
interface ScriptedRead {
	rc: number;
	xml?: string;
	flags?: number;
	/** What `WlanGetProfileCustomUserData` reports alongside it. Absent means none. */
	custom?: string;
}

/** A Win32 code `WlanSetProfileCustomUserData` answers with, instead of succeeding. */
const CUSTOM_DATA_WRITE_FAILED = 6;

/** One recorded WlanSetProfile call. */
interface RecordedWrite {
	flags: number;
	overwrite: number;
}

/**
 * A WlanApi that answers WlanGetProfile from a script — one entry per call, in
 * order — and records every WlanSetProfile. `setResults` supplies the Win32 code
 * each write returns, so the ERROR_ALREADY_EXISTS race can be reproduced exactly.
 */
function joinApi(reads: ScriptedRead[], setResults: number[] = [], documents: string[] = [], customSetResult: number = 0) {
	const writes: RecordedWrite[] = [];
	/** Every custom-user-data blob handed back, in order, as text. */
	const restored: string[] = [];
	let readIndex = 0;
	let writeIndex = 0;
	// Whatever the last scripted read reported, so the custom-data call that follows
	// it answers for the same profile.
	let pendingCustom: string | undefined;
	const api = {
		WlanGetProfile: (_handle: bigint, _guid: Pointer, _name: Pointer, _reserved: null, xmlOut: Pointer, flagsOut: Pointer) => {
			const scripted = reads[readIndex++];
			if (!scripted) throw new Error('WlanGetProfile was called more times than the case scripted');
			const document = scripted.xml === undefined ? null : utf16z(scripted.xml);
			if (document) retainedProfiles.push(document);
			new BigUint64Array(toArrayBuffer(xmlOut, 0, 8))[0] = document ? BigInt(ptr(document)) : 0n;
			new Uint32Array(toArrayBuffer(flagsOut, 0, 4))[0] = scripted.flags ?? 0;
			pendingCustom = scripted.custom;
			return scripted.rc;
		},
		WlanGetProfileCustomUserData: (_handle: bigint, _guid: Pointer, _name: Pointer, _reserved: null, sizeOut: Pointer, dataOut: Pointer) => {
			// ERROR_FILE_NOT_FOUND, which is what a profile with no custom data answers.
			if (pendingCustom === undefined) return 2;
			const blob = new TextEncoder().encode(pendingCustom);
			retainedBlobs.push(blob);
			new Uint32Array(toArrayBuffer(sizeOut, 0, 4))[0] = blob.length;
			new BigUint64Array(toArrayBuffer(dataOut, 0, 8))[0] = BigInt(ptr(blob));
			return 0;
		},
		WlanSetProfileCustomUserData: (_handle: bigint, _guid: Pointer, _name: Pointer, size: number, data: Pointer) => {
			restored.push(new TextDecoder().decode(new Uint8Array(toArrayBuffer(data, 0, size))));
			return customSetResult;
		},
		WlanSetProfile: (_handle: bigint, _guid: Pointer, flags: number, xml: Pointer, _security: null, overwrite: number) => {
			writes.push({ flags, overwrite });
			documents.push(readUtf16z(xml));
			return setResults[writeIndex++] ?? 0;
		},
		WlanReasonCodeToString: () => 1,
		WlanFreeMemory: () => {},
	} as unknown as Parameters<typeof writeJoinProfile>[0];
	return { api, writes, restored };
}

/** Custom-data buffers kept alive for as long as the FFI mock may hold a pointer into them. */
const retainedBlobs: Uint8Array[] = [];

/** ERROR_NOT_FOUND / ERROR_ALREADY_EXISTS, as Windows returns them. */
const NOT_FOUND = 1168;
const ALREADY_EXISTS = 183;
/** WLAN_PROFILE_USER / WLAN_PROFILE_GROUP_POLICY. */
const USER_FLAGS = 2;
const POLICY_FLAGS = 1;

/** The SSID every fake profile below targets, as the hex a WLAN profile carries. */
const SSID_HEX = '4578616D706C65';

/**
 * A stored profile as Windows hands one back: the SSID it belongs to, the user's
 * own settings around it, and the credentials — encrypted, because nothing here
 * asks for the plaintext key. `marker` distinguishes one fixture from another.
 */
function stored(marker: string): string {
	return `<WLANProfile><name>Example</name><SSIDConfig><SSID><hex>${SSID_HEX}</hex></SSID></SSIDConfig><connectionMode>auto</connectionMode><MacRandomization><enableRandomization>true</enableRandomization></MacRandomization><MSM><security><authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption><sharedKey><keyType>passPhrase</keyType><keyMaterial>${marker}</keyMaterial></sharedKey><FIPSMode>true</FIPSMode></security></MSM></WLANProfile>`;
}

/** What a join is trying to write, for the network every fixture here belongs to. */
function target(newProfile: string): JoinTarget {
	return { ssidHex: SSID_HEX, password: 'hunter2000', sae: false, newProfile: () => newProfile };
}

describe('writeJoinProfile', () => {
	it('stops when Windows refuses the overwrite instead of reporting it as written', () => {
		// ERROR_ALREADY_EXISTS answers a CREATE — the name was taken. Answered to an
		// overwrite it means Windows did NOT write, which it documents for a profile
		// whose scope changed since it was read. Tolerating it there reported a
		// password as saved that was never stored, and then associated through the old
		// profile and called that success.
		const { api, restored } = joinApi([{ rc: 0, xml: stored('old'), flags: USER_FLAGS }], [ALREADY_EXISTS]);
		expect(() => writeJoinProfile(api, 1n, ANY_GUID, 'Example', target('<WLANProfile>new</WLANProfile>'))).toThrow();
		// And it stops there: no custom data is put back for a write that did not land.
		expect(restored).toEqual([]);
	});

	it('refuses a profile of the same name that belongs to another network', () => {
		// A profile NAME is not a network — Windows lets them differ, and this app
		// falls back to the SSID for the name when the scan names no profile. A saved
		// "Office" pointing at another SSID must not be destroyed by joining a new
		// network that happens to be called the same, least of all on SUCCESS where
		// nothing rolls anything back.
		const foreign = stored('other network').replace(SSID_HEX, '4F7468657231');
		const { api, writes } = joinApi([{ rc: 0, xml: foreign, flags: USER_FLAGS }]);
		expect(() => writeJoinProfile(api, 1n, ANY_GUID, 'Example', target('<WLANProfile>new</WLANProfile>'))).toThrow(/a different network is already saved under this name/);
		expect(writes).toEqual([]);
	});

	it('changes only the credentials of a profile it replaces', () => {
		// Regenerating the document kept the SSID and the key and dropped everything
		// else the user had set — MAC randomisation, the connection mode, whatever a
		// later Windows adds — and a successful join left the stripped version behind.
		const written: string[] = [];
		const { api } = joinApi(
			[
				{ rc: 0, xml: stored('old key'), flags: USER_FLAGS },
				{ rc: 0, xml: stored('old key'), flags: USER_FLAGS },
			],
			[],
			written
		);
		writeJoinProfile(api, 1n, ANY_GUID, 'Example', target('<WLANProfile>new</WLANProfile>'));
		const document = written[0] as string;
		expect(document).toContain('<enableRandomization>true</enableRandomization>');
		expect(document).toContain('<connectionMode>auto</connectionMode>');
		expect(document).toContain('<FIPSMode>true</FIPSMode>');
		expect(document).toContain(`<hex>${SSID_HEX}</hex>`);
		// And the one thing the join is actually changing did change.
		expect(document).toContain('<keyMaterial>hunter2000</keyMaterial>');
		expect(document).not.toContain('old key');
	});

	it('refuses a stored profile it cannot edit rather than replacing it wholesale', () => {
		// No `<security>` to swap means this is not a document this code understands,
		// and writing a generated one over it is exactly the loss above.
		const odd = `<WLANProfile><SSIDConfig><SSID><hex>${SSID_HEX}</hex></SSID></SSIDConfig></WLANProfile>`;
		const { api, writes } = joinApi([{ rc: 0, xml: odd, flags: USER_FLAGS }]);
		expect(() => writeJoinProfile(api, 1n, ANY_GUID, 'Example', target('<WLANProfile>new</WLANProfile>'))).toThrow(/not in a shape this app can edit/);
		expect(writes).toEqual([]);
	});

	it('overwrites an existing profile keeping its scope, and marks it for restore', () => {
		const { api, writes } = joinApi([
			{ rc: 0, xml: stored('old'), flags: USER_FLAGS },
			{ rc: 0, xml: stored('normalized'), flags: USER_FLAGS },
		]);
		const change = writeJoinProfile(api, 1n, ANY_GUID, 'Example', target('<WLANProfile>new</WLANProfile>'));
		expect(change).toEqual({ replaced: { xml: stored('old'), flags: USER_FLAGS, customUserData: null }, created: false, written: { xml: stored('normalized'), flags: USER_FLAGS, customUserData: null } });
		// Rewritten with the flags it already had — restoring a per-user profile as
		// all-user would be a different object under the same name.
		expect(writes).toEqual([{ flags: USER_FLAGS, overwrite: 1 }]);
	});

	// The overwrite that replaces the credentials also destroys whatever another
	// WLAN client kept beside the profile. Replacing the credentials is what the
	// user asked for; destroying somebody else's metadata is not.
	it('hands the custom user data back after overwriting a profile', () => {
		const { api, restored } = joinApi([
			{ rc: 0, xml: stored('old'), flags: USER_FLAGS, custom: 'vendor-metadata' },
			{ rc: 0, xml: stored('normalized'), flags: USER_FLAGS, custom: 'vendor-metadata' },
		]);
		writeJoinProfile(api, 1n, ANY_GUID, 'Example', target('<WLANProfile>new</WLANProfile>'));
		expect(restored).toEqual(['vendor-metadata']);
	});

	// The setter's return code used to be discarded on the grounds that the write
	// which lost the data had already happened. That reasoning holds on the rollback
	// path and not here: this runs BEFORE the association is attempted, so the failure
	// can be reported, the original profile put back, and no connection made.
	it('refuses the join when the custom user data cannot be handed back', () => {
		const { api, writes } = joinApi(
			[
				{ rc: 0, xml: stored('old'), flags: USER_FLAGS, custom: 'vendor-metadata' },
				{ rc: 0, xml: stored('normalized'), flags: USER_FLAGS, custom: 'vendor-metadata' },
			],
			[],
			[],
			CUSTOM_DATA_WRITE_FAILED
		);
		expect(() => writeJoinProfile(api, 1n, ANY_GUID, 'Example', target('<WLANProfile>new</WLANProfile>'))).toThrow(/could not be put back, so this network was not joined/);
		// The overwrite, and then the write that puts the original document back.
		expect(writes).toEqual([
			{ flags: USER_FLAGS, overwrite: 1 },
			{ flags: USER_FLAGS, overwrite: 1 },
		]);
	});

	it('writes no custom user data for a profile that had none', () => {
		const { api, restored } = joinApi([
			{ rc: 0, xml: stored('old'), flags: USER_FLAGS },
			{ rc: 0, xml: stored('normalized'), flags: USER_FLAGS },
		]);
		writeJoinProfile(api, 1n, ANY_GUID, 'Example', target('<WLANProfile>new</WLANProfile>'));
		// A zero-length write is a clear, not a no-op, so there is nothing to send.
		expect(restored).toEqual([]);
	});

	it('creates a profile only when Windows confirms the name was free', () => {
		const { api, writes } = joinApi([{ rc: NOT_FOUND }, { rc: 0, xml: stored('normalized'), flags: USER_FLAGS }]);
		expect(writeJoinProfile(api, 1n, ANY_GUID, 'Example', target('<WLANProfile>new</WLANProfile>'))).toEqual({ replaced: null, created: true, written: { xml: stored('normalized'), flags: USER_FLAGS, customUserData: null } });
		// bOverwrite FALSE: the write is what CHECKS the absence, not just what acts on it.
		expect(writes).toEqual([{ flags: USER_FLAGS, overwrite: 0 }]);
	});

	// The race. Between the read that found nothing and the write, another process
	// saves a profile under that name. Writing with bOverwrite TRUE would replace
	// it while this attempt believed it had CREATED it — and the rollback would
	// then delete a network the user had just saved.
	it('does not claim to have created a profile that appeared mid-attempt', () => {
		const { api, writes } = joinApi([{ rc: NOT_FOUND }, { rc: 0, xml: stored('raced'), flags: USER_FLAGS }, { rc: 0, xml: stored('normalized'), flags: USER_FLAGS }], [ALREADY_EXISTS]);
		const change = writeJoinProfile(api, 1n, ANY_GUID, 'Example', target('<WLANProfile>new</WLANProfile>'));
		// created FALSE is the whole point: the rollback restores rather than deletes.
		expect(change.created).toBe(false);
		expect(change.replaced).toEqual({ xml: stored('raced'), flags: USER_FLAGS, customUserData: null });
		expect(writes).toEqual([
			{ flags: USER_FLAGS, overwrite: 0 },
			{ flags: USER_FLAGS, overwrite: 1 },
		]);
	});

	it('leaves a raced profile alone when it cannot be backed up', () => {
		const { api, writes } = joinApi([{ rc: NOT_FOUND }, { rc: 5 }], [ALREADY_EXISTS]);
		expect(() => writeJoinProfile(api, 1n, ANY_GUID, 'Example', target('<WLANProfile>new</WLANProfile>'))).toThrow();
		// The refused overwrite is the only write attempted; nothing was replaced.
		expect(writes).toEqual([{ flags: USER_FLAGS, overwrite: 0 }]);
	});

	it('writes nothing at all when the existing profile could not be read', () => {
		const { api, writes } = joinApi([{ rc: 5 }]);
		expect(() => writeJoinProfile(api, 1n, ANY_GUID, 'Example', target('<WLANProfile>new</WLANProfile>'))).toThrow();
		expect(writes).toEqual([]);
	});

	it('refuses a group-policy profile, before and after the race', () => {
		const policy = joinApi([{ rc: 0, xml: stored('kept'), flags: POLICY_FLAGS }]);
		expect(() => writeJoinProfile(policy.api, 1n, ANY_GUID, 'Example', target('<WLANProfile>new</WLANProfile>'))).toThrow(/group policy/);
		expect(policy.writes).toEqual([]);
		// A policy profile pushed between the read and the write is refused too.
		const raced = joinApi([{ rc: NOT_FOUND }, { rc: 0, xml: stored('kept'), flags: POLICY_FLAGS }], [ALREADY_EXISTS]);
		expect(() => writeJoinProfile(raced.api, 1n, ANY_GUID, 'Example', target('<WLANProfile>new</WLANProfile>'))).toThrow(/group policy/);
		expect(raced.writes).toEqual([{ flags: USER_FLAGS, overwrite: 0 }]);
	});

	// Windows normalizes the document it is given and stores the key material
	// encrypted, so what comes back is never what was sent — which is exactly why
	// the fingerprint is read rather than assumed.
	it('fingerprints the profile as Windows stores it, not as it was written', () => {
		const { api } = joinApi([{ rc: NOT_FOUND }, { rc: 0, xml: stored('as stored'), flags: USER_FLAGS }]);
		expect(writeJoinProfile(api, 1n, ANY_GUID, 'Example', target(stored('as written'))).written?.xml).toBe(stored('as stored'));
	});

	it('reports no fingerprint rather than failing when the read-back does not answer', () => {
		// The write succeeded; failing the join over a fingerprint would report a
		// failure that did not happen. What it costs is the rollback's proof.
		const { api } = joinApi([{ rc: NOT_FOUND }, { rc: 5 }]);
		expect(writeJoinProfile(api, 1n, ANY_GUID, 'Example', target('<WLANProfile>new</WLANProfile>')).written).toBeNull();
	});
});

/**
 * The other end of the same race the write path already refuses.
 *
 * Twenty seconds of waiting for an association sit between the write and the
 * rollback, and the host mutex covers this process alone — the Windows UI,
 * `netsh`, a policy refresh or a second instance of this app can all save a
 * profile under that name inside the window. An unconditional undo then discards
 * a change the user had just made.
 */
describe('undoProfileChange', () => {
	const WRITTEN = { xml: stored('ours'), flags: USER_FLAGS, customUserData: null };
	const PREVIOUS = { xml: stored('theirs'), flags: USER_FLAGS, customUserData: null };

	/** A WlanApi that answers one WlanGetProfile and records the delete and the write. */
	function undoApi(read: ScriptedRead, customSetResult: number = 0) {
		const deletes: number[] = [];
		const writes: RecordedWrite[] = [];
		const restored: string[] = [];
		const api = {
			WlanGetProfile: (_handle: bigint, _guid: Pointer, _name: Pointer, _reserved: null, xmlOut: Pointer, flagsOut: Pointer) => {
				const document = read.xml === undefined ? null : utf16z(read.xml);
				if (document) retainedProfiles.push(document);
				new BigUint64Array(toArrayBuffer(xmlOut, 0, 8))[0] = document ? BigInt(ptr(document)) : 0n;
				new Uint32Array(toArrayBuffer(flagsOut, 0, 4))[0] = read.flags ?? 0;
				return read.rc;
			},
			WlanGetProfileCustomUserData: (_handle: bigint, _guid: Pointer, _name: Pointer, _reserved: null, sizeOut: Pointer, dataOut: Pointer) => {
				if (read.custom === undefined) return 2;
				const blob = new TextEncoder().encode(read.custom);
				retainedBlobs.push(blob);
				new Uint32Array(toArrayBuffer(sizeOut, 0, 4))[0] = blob.length;
				new BigUint64Array(toArrayBuffer(dataOut, 0, 8))[0] = BigInt(ptr(blob));
				return 0;
			},
			WlanSetProfileCustomUserData: (_handle: bigint, _guid: Pointer, _name: Pointer, size: number, data: Pointer) => {
				restored.push(new TextDecoder().decode(new Uint8Array(toArrayBuffer(data, 0, size))));
				return customSetResult;
			},
			WlanDeleteProfile: () => {
				deletes.push(1);
				return 0;
			},
			WlanSetProfile: (_handle: bigint, _guid: Pointer, flags: number, _xml: Pointer, _security: null, overwrite: number) => {
				writes.push({ flags, overwrite });
				return 0;
			},
			WlanReasonCodeToString: () => 1,
			WlanFreeMemory: () => {},
		} as unknown as Parameters<typeof undoProfileChange>[0];
		return { api, deletes, writes, restored };
	}

	it('deletes a profile this attempt created and nobody has touched', () => {
		const { api, deletes } = undoApi({ rc: 0, xml: WRITTEN.xml, flags: WRITTEN.flags });
		expect(undoProfileChange(api, 1n, ANY_GUID, 'Example', { replaced: null, created: true, written: WRITTEN })).toBeNull();
		expect(deletes).toEqual([1]);
	});

	it('restores a profile this attempt overwrote and nobody has touched', () => {
		const { api, writes } = undoApi({ rc: 0, xml: WRITTEN.xml, flags: WRITTEN.flags });
		expect(undoProfileChange(api, 1n, ANY_GUID, 'Example', { replaced: PREVIOUS, created: false, written: WRITTEN })).toBeNull();
		// With the flags it had: a per-user profile put back as all-user is a
		// different object under the same name.
		expect(writes).toEqual([{ flags: USER_FLAGS, overwrite: 1 }]);
	});

	// Undoing the document is only half of undoing the write: the WlanSetProfile
	// that puts the old document back discards the custom user data all over again,
	// exactly as the failed attempt's own write did.
	it('hands the custom user data back with the profile it restores', () => {
		const { api, restored } = undoApi({ rc: 0, xml: WRITTEN.xml, flags: WRITTEN.flags });
		expect(undoProfileChange(api, 1n, ANY_GUID, 'Example', { replaced: { ...PREVIOUS, customUserData: new TextEncoder().encode('vendor-metadata') }, created: false, written: WRITTEN })).toBeNull();
		expect(restored).toEqual(['vendor-metadata']);
	});

	it('keeps a profile another process changed, rather than deleting it', () => {
		const { api, deletes, writes } = undoApi({ rc: 0, xml: stored('someone else'), flags: USER_FLAGS });
		expect(undoProfileChange(api, 1n, ANY_GUID, 'Example', { replaced: null, created: true, written: WRITTEN })).toContain('another process changed');
		expect(deletes).toEqual([]);
		expect(writes).toEqual([]);
	});

	it('keeps a profile another process changed, rather than overwriting it back', () => {
		const { api, writes } = undoApi({ rc: 0, xml: stored('someone else'), flags: USER_FLAGS });
		expect(undoProfileChange(api, 1n, ANY_GUID, 'Example', { replaced: PREVIOUS, created: false, written: WRITTEN })).toContain('another process changed');
		expect(writes).toEqual([]);
	});

	// The custom user data is the one part of the profile another WLAN client can
	// change on its own, leaving the document and the flags untouched. Comparing only
	// those two judged the profile still ours, so the rollback deleted the new profile
	// along with the foreign blob — or put the older blob back over the newer one.
	it('treats a changed custom data blob as somebody else having been here', () => {
		const written = { ...WRITTEN, customUserData: new TextEncoder().encode('ours') };
		const { api, deletes, writes } = undoApi({ rc: 0, xml: WRITTEN.xml, flags: WRITTEN.flags, custom: 'theirs, written since' });
		expect(undoProfileChange(api, 1n, ANY_GUID, 'Example', { replaced: null, created: true, written })).toContain('another process changed');
		expect(deletes).toEqual([]);
		expect(writes).toEqual([]);
	});

	// ...and a blob that has NOT changed still matches, though it is a different array
	// each time it is read. Compared by content, not by reference — otherwise every
	// profile carrying custom data would look like a conflict.
	it('matches an unchanged custom data blob read back as a fresh array', () => {
		const written = { ...WRITTEN, customUserData: new TextEncoder().encode('vendor-metadata') };
		const { api, deletes } = undoApi({ rc: 0, xml: WRITTEN.xml, flags: WRITTEN.flags, custom: 'vendor-metadata' });
		expect(undoProfileChange(api, 1n, ANY_GUID, 'Example', { replaced: null, created: true, written })).toBeNull();
		expect(deletes).toEqual([1]);
	});

	// A blob that cannot be READ is a conflict too: there is then no way to tell
	// whether the profile is still this attempt's, and acting anyway is the guess the
	// whole fingerprint exists to avoid.
	it('will not act when the current custom data cannot be read', () => {
		const { api, deletes, writes } = undoApi({ rc: 0, xml: WRITTEN.xml, flags: WRITTEN.flags });
		const failing = { ...api, WlanGetProfileCustomUserData: () => 1727 } as typeof api;
		expect(undoProfileChange(failing, 1n, ANY_GUID, 'Example', { replaced: PREVIOUS, created: false, written: WRITTEN })).toContain('could not be re-read');
		expect(deletes).toEqual([]);
		expect(writes).toEqual([]);
	});

	// The restore is only done when the blob is back with the document. Reporting null
	// here claimed a restore that had left another program's data destroyed.
	it('reports a custom data restore that failed alongside the document', () => {
		const { api } = undoApi({ rc: 0, xml: WRITTEN.xml, flags: WRITTEN.flags }, CUSTOM_DATA_WRITE_FAILED);
		const previous = { ...PREVIOUS, customUserData: new TextEncoder().encode('vendor-metadata') };
		expect(undoProfileChange(api, 1n, ANY_GUID, 'Example', { replaced: previous, created: false, written: WRITTEN })).toContain('the data another program stores with it was not');
	});

	// The scope is as much a part of the object as the document: a profile
	// re-scoped by another process is not the one this attempt wrote.
	it('treats a changed scope as a change like any other', () => {
		const { api, deletes } = undoApi({ rc: 0, xml: WRITTEN.xml, flags: POLICY_FLAGS });
		expect(undoProfileChange(api, 1n, ANY_GUID, 'Example', { replaced: null, created: true, written: WRITTEN })).toContain('another process changed');
		expect(deletes).toEqual([]);
	});

	it('will not act at all when the write could not be fingerprinted', () => {
		const { api, deletes, writes } = undoApi({ rc: 0, xml: WRITTEN.xml, flags: WRITTEN.flags });
		expect(undoProfileChange(api, 1n, ANY_GUID, 'Example', { replaced: PREVIOUS, created: false, written: null })).toContain('could not be read back');
		expect(deletes).toEqual([]);
		expect(writes).toEqual([]);
	});

	it('will not act when the profile cannot be re-read', () => {
		const { api, deletes } = undoApi({ rc: 5 });
		expect(undoProfileChange(api, 1n, ANY_GUID, 'Example', { replaced: null, created: true, written: WRITTEN })).toContain('could not be re-read');
		expect(deletes).toEqual([]);
	});

	// The undo's goal for a created profile was that it not exist, and it does not.
	it('is satisfied when a profile it created has already been removed', () => {
		const { api, deletes } = undoApi({ rc: NOT_FOUND });
		expect(undoProfileChange(api, 1n, ANY_GUID, 'Example', { replaced: null, created: true, written: WRITTEN })).toBeNull();
		expect(deletes).toEqual([]);
	});

	it('does not resurrect a profile another process removed', () => {
		const { api, writes } = undoApi({ rc: NOT_FOUND });
		expect(undoProfileChange(api, 1n, ANY_GUID, 'Example', { replaced: PREVIOUS, created: false, written: WRITTEN })).toContain('another process removed');
		expect(writes).toEqual([]);
	});
});
