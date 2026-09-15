import { describe, expect, it } from 'bun:test';
import { type JoinTarget, assertProfileNameWritable, assertWindowsWifiKey, openJoinDecision, withJoinCredentials, windowsWifiProfileXml } from '../../src/system-network-windows.ts';

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
