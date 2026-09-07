import { describe, expect, it } from 'bun:test';
import { ptr, type Pointer } from 'bun:ffi';
import { type AvailableNetwork, findScannedNetwork, parseAvailableNetworks } from '../../src/system-network-windows.ts';

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
	/** dot11DefaultCipherAlgorithm. Defaults to CCMP for a secured row and NONE for an open one. */
	cipher?: number;
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
		view.setUint32(base + 616, network.cipher ?? (network.secured === false ? 0 : 4), true);
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
			{ ssid: 'Coffee Bar', bssid: null, signal: 71, secured: true, security: 'WPA2', supported: true, active: true, connectable: true },
			{ ssid: 'Open Guest Net', bssid: null, signal: 40, secured: false, security: '', supported: false, active: false, connectable: true },
		]);
	});

	it('offers only the cipher it can actually write a profile for', () => {
		// The authentication method is half the answer: every profile this app writes
		// says `<encryption>AES</encryption>`, so a WPA2 network running TKIP was
		// offered as joinable and then handed a profile demanding a cipher it does not
		// speak. The association failed and the message sent the user to check a
		// password that was never the problem.
		const rows = parseAvailableNetworks(
			buildList([
				{ ssid: 'Aes Net', signal: 80, auth: 7, cipher: 4 },
				{ ssid: 'Tkip Net', signal: 70, auth: 7, cipher: 2 },
				{ ssid: 'Sae Net', signal: 60, auth: 9, cipher: 4 },
				{ ssid: 'Sae Tkip', signal: 50, auth: 9, cipher: 2 },
			])
		);
		const byName = (name: string) => rows.find(row => row.ssid === name);
		expect(byName('Aes Net')).toMatchObject({ security: 'WPA2', supported: true });
		expect(byName('Sae Net')).toMatchObject({ security: 'WPA3', supported: true });
		expect(byName('Tkip Net')).toMatchObject({ supported: false });
		expect(byName('Sae Tkip')).toMatchObject({ supported: false });
	});

	it('calls an open network open only when it really carries no cipher', () => {
		const rows = parseAvailableNetworks(
			buildList([
				{ ssid: 'Open', signal: 80, secured: false, auth: 1, cipher: 0 },
				{ ssid: 'Odd', signal: 70, secured: false, auth: 1, cipher: 2 },
			])
		);
		expect(rows.find(row => row.ssid === 'Open')).toMatchObject({ security: '', supported: true });
		expect(rows.find(row => row.ssid === 'Odd')).toMatchObject({ supported: false });
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
		expect(parseAvailableNetworks(list)).toEqual([{ ssid: 'Roaming Net', bssid: null, signal: 88, secured: true, security: 'WPA2', supported: true, active: false, connectable: true }]);
	});

	it('keeps the connected flag when the associated entry is not the strongest one', () => {
		const list = buildList([
			{ ssid: 'Roaming Net', signal: 30, active: true },
			{ ssid: 'Roaming Net', signal: 88 },
		]);
		expect(parseAvailableNetworks(list)[0]).toEqual({ ssid: 'Roaming Net', bssid: null, signal: 88, secured: true, security: 'WPA2', supported: true, active: true, connectable: true });
		const reversed = buildList([
			{ ssid: 'Roaming Net', signal: 88 },
			{ ssid: 'Roaming Net', signal: 30, active: true },
		]);
		expect(parseAvailableNetworks(reversed)[0]).toEqual({ ssid: 'Roaming Net', bssid: null, signal: 88, secured: true, security: 'WPA2', supported: true, active: true, connectable: true });
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

describe('Windows scan connectability', () => {
	const policyReason = 0x2800b;
	const reasonText = (reason: number) => reason === policyReason ? 'Připojení zakazuje zásada systému.' : null;
	const blocked: NetworkFields = { ssid: 'Example', signal: 80, auth: 7, cipher: 4, connectable: false, notConnectableReason: policyReason };
	const allowed: NetworkFields = { ...blocked, signal: 40, connectable: true };

	it('publishes an OS refusal separately from supported WPA2 authentication', () => {
		const list = buildList([blocked, { ...allowed, ssid: 'Other' }]);
		const [unavailable, available] = parseAvailableNetworks(list, reasonText);
		expect(unavailable).toMatchObject({ ssid: 'Example', security: 'WPA2', supported: true, connectable: false, unavailableReason: 'Připojení zakazuje zásada systému.' });
		expect(available).toMatchObject({ ssid: 'Other', supported: true, connectable: true });
		expect(available).not.toHaveProperty('unavailableReason');
	});

	it('keeps the refusal when Windows has no explanation for it', () => {
		const list = buildList([blocked]);
		for (const rows of [parseAvailableNetworks(list), parseAvailableNetworks(list, () => null)]) {
			expect(rows[0]).toMatchObject({ supported: true, connectable: false });
			expect(rows[0]).not.toHaveProperty('unavailableReason');
		}
	});

	it('does not offer a weaker connectable row when the join selects a stronger refused row', () => {
		for (const rows of [[blocked, allowed], [allowed, blocked]]) {
			const list = buildList(rows);
			expect(parseAvailableNetworks(list, reasonText)).toHaveLength(1);
			expect(parseAvailableNetworks(list, reasonText)[0]).toMatchObject({ signal: 80, connectable: false, unavailableReason: reasonText(policyReason) });
			expect(onlyMatch(findScannedNetwork(list, 'Example'))).toMatchObject({ connectable: false, notConnectableReason: policyReason });
		}
	});

	it('does not carry a weaker refusal into a connectable selection', () => {
		const stronger = { ...allowed, signal: 90 };
		for (const rows of [[blocked, stronger], [stronger, blocked]]) {
			const list = buildList(rows);
			const [selected] = parseAvailableNetworks(list, reasonText);
			expect(selected).toMatchObject({ signal: 90, connectable: true });
			expect(selected).not.toHaveProperty('unavailableReason');
			expect(onlyMatch(findScannedNetwork(list, 'Example'))).toMatchObject({ connectable: true });
		}
	});

	it('uses the same first-row tie break as the join for equal signals', () => {
		const equal = { ...allowed, signal: blocked.signal };
		for (const rows of [[blocked, equal], [equal, blocked]]) {
			const list = buildList(rows);
			const [selected] = parseAvailableNetworks(list, reasonText);
			const target = onlyMatch(findScannedNetwork(list, 'Example'));
			expect(selected?.connectable).toBe(target?.connectable);
			expect(selected?.unavailableReason).toBe(target?.connectable ? undefined : reasonText(policyReason) ?? undefined);
		}
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

describe('parseAvailableNetworks with one name on differently secured access points', () => {
	// Real case: an open guest network the interface is ON, and an unrelated WPA2
	// network of the same name with a stronger signal.
	const rows = [
		{ ssid: 'Guests', signal: 40, secured: false, auth: 1, cipher: 0, active: true },
		{ ssid: 'Guests', signal: 80, secured: true, auth: 7, cipher: 4, active: false },
	];

	it('never reports the association of one row with the security of another', () => {
		// The merged row claimed "Guests, WPA2, connected" — a reading neither access
		// point advertised, and the one the join guard then refuses as already joined.
		for (const order of [rows, [...rows].reverse()]) {
			const networks = parseAvailableNetworks(buildList(order));
			const joined = networks.filter(item => item.active);
			expect(joined).toHaveLength(1);
			expect(joined[0]).toMatchObject({ ssid: 'Guests', secured: false, signal: 40 });
		}
	});

	it('keeps both, because they are not the same network', () => {
		const networks = parseAvailableNetworks(buildList(rows));
		expect(networks.map(item => [item.security, item.signal, item.active])).toEqual([
			['WPA2', 80, false],
			['', 40, true],
		]);
	});

	it('still collapses access points that agree on security', () => {
		const same = [
			{ ssid: 'Office', signal: 30, secured: true, auth: 7, cipher: 4, active: true },
			{ ssid: 'Office', signal: 90, secured: true, auth: 7, cipher: 4, active: false },
		];
		const networks = parseAvailableNetworks(buildList(same));
		expect(networks).toHaveLength(1);
		expect(networks[0]).toMatchObject({ signal: 90, active: true });
	});
});
