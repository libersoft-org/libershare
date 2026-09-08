import { describe, expect, it } from 'bun:test';
import { ptr, toArrayBuffer, type Pointer } from 'bun:ffi';
import { type JoinTarget, guidToBytes, readStoredProfile, readUtf16z, undoProfileChange, writeJoinProfile, utf16z } from '../../src/system-network-windows.ts';

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
		// Scripted with enough reads for the WHOLE happy path, so the only thing that
		// can stop this attempt is the refused write itself. Without that the test
		// passed on the mock running out of scripted reads — it threw, but not for
		// the reason it claimed to be pinning.
		const { api, restored } = joinApi(
			[
				{ rc: 0, xml: stored('old'), flags: USER_FLAGS },
				{ rc: 0, xml: stored('normalized'), flags: USER_FLAGS },
			],
			[ALREADY_EXISTS]
		);
		expect(() => writeJoinProfile(api, 1n, ANY_GUID, 'Example', target('<WLANProfile>new</WLANProfile>'))).toThrow(/0xB7/);
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
