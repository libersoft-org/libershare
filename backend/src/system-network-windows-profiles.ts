import { ptr, toArrayBuffer, type Pointer } from 'bun:ffi';
import { isWifiHexKey } from '@shared';
import { type WlanApi, type WlanHandle, utf16z, readUtf16z, withWlanHandle, wlanErrorMessage, describeProfileFailure, ERROR_NOT_FOUND, ERROR_FILE_NOT_FOUND, ERROR_ALREADY_EXISTS, WLAN_PROFILE_GROUP_POLICY, WLAN_PROFILE_USER } from './system-network-windows-wlan.ts';


/**
 * Control characters an XML 1.0 document cannot carry, even escaped.
 *
 * A WLAN profile IS a document, and the profile name goes into it as text - the
 * SSID itself is written as hex and is safe whatever bytes it holds. A name
 * carrying one of these makes WlanSetProfile refuse the document as malformed
 * rather than as a wrong name, so it is refused here where that can be said.
 * Tab, LF and CR are legal there and stay out of the set. This is a WINDOWS rule
 * and lives on the Windows side: the same name is perfectly joinable through
 * NetworkManager.
 */
const XML_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

/** Refuse a profile name a WLAN profile document could not carry. */
export function assertProfileNameWritable(profileName: string): void {
	if (XML_FORBIDDEN.test(profileName)) throw new Error('this network name contains characters a Windows profile cannot store');
}

/** Escape the five XML metacharacters. An SSID may legally contain any of them. */
function escapeXml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * The `<sharedKey>` element for one credential, or empty for an open network.
 */
function sharedKeyElement(password: string): string {
	// A 64-hex credential is a raw 256-bit PSK, not a passphrase, and the profile
	// has to say so: announced as `passPhrase` Windows hashes it a second time, so
	// the profile is written, accepted, and then simply never authenticates.
	const keyType = isWifiHexKey(password) ? 'networkKey' : 'passPhrase';
	return password ? `<sharedKey><keyType>${keyType}</keyType><protected>false</protected><keyMaterial>${escapeXml(password)}</keyMaterial></sharedKey>` : '';
}

/**
 * The `<security>` element a NEW profile needs. Empty password means an open network.
 */
function joinSecurityElement(password: string, sae: boolean): string {
	const method = password ? (sae ? 'WPA3SAE' : 'WPA2PSK') : 'open';
	const cipher = password ? 'AES' : 'none';
	return `<authEncryption><authentication>${method}</authentication><encryption>${cipher}</encryption><useOneX>false</useOneX></authEncryption>${sharedKeyElement(password)}`;
}

/**
 * The SSID a stored profile targets, as uppercase hex.
 *
 * Windows keeps the profile NAME and the SSID apart, so a name says nothing
 * about which network a profile belongs to: a profile called "Office" can target
 * any SSID at all. Null when the document names no SSID, which is a document
 * this code will not reason about.
 */
export function profileSsidHex(xml: string): string | null {
	const hex = xml.match(/<hex>\s*([0-9a-f]+)\s*<\/hex>/i);
	if (hex?.[1]) return hex[1].toUpperCase();
	// Older documents carry the name form instead; it is only unambiguous for an
	// SSID that really is text, which is exactly when Windows writes it.
	const name = xml.match(/<SSID>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/SSID>/i);
	return name?.[1] === undefined ? null : ssidHex(new TextEncoder().encode(unescapeXml(name[1])));
}

/** The SSID bytes as the uppercase hex a WLAN profile carries. */
export function ssidHex(ssidBytes: Uint8Array): string {
	return [...ssidBytes].map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join('');
}

/** The five entities `escapeXml` produces, back to the characters they stand for. */
function unescapeXml(text: string): string {
	return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name] as string);
}

/**
 * The stored document with its credentials changed and nothing else.
 *
 * A join must not rewrite a profile the user already has. Replacing the whole
 * `<security>` element still dropped what lived inside it beside the key - a
 * profile with `<FIPSMode>true</FIPSMode>` came back without it, which is a
 * security setting and not a formatting detail - so only the three elements the
 * join actually decides are touched: the method, the cipher and the key.
 *
 * Every write goes through {@link spliceAt}, never `String.replace` with a computed
 * replacement: there `$$`, `$&` and `$`` in the text are substitution syntax, so a
 * password containing one was silently rewritten before it ever reached Windows.
 *
 * Null when the document is not shaped like one Windows hands back. The caller
 * then refuses rather than falling back to a generated document, because that
 * fallback is the data loss this exists to prevent.
 */
export function withJoinCredentials(xml: string, password: string, sae: boolean): string | null {
	const security = xml.match(/<security>[\s\S]*?<\/security>/i);
	if (!security) return null;
	const method = xml.slice(security.index).match(/<authentication>[\s\S]*?<\/authentication>/i);
	const cipher = xml.slice(security.index).match(/<encryption>[\s\S]*?<\/encryption>/i);
	if (!method || !cipher) return null;
	let edited = security[0];
	edited = spliceAt(edited, method[0], `<authentication>${password ? (sae ? 'WPA3SAE' : 'WPA2PSK') : 'open'}</authentication>`);
	edited = spliceAt(edited, cipher[0], `<encryption>${password ? 'AES' : 'none'}</encryption>`);
	const key = sharedKeyElement(password);
	const stored = edited.match(/<sharedKey>[\s\S]*?<\/sharedKey>/i);
	// An open profile has no key element to replace, so the new one goes where
	// the schema puts it: straight after the method it belongs to.
	if (stored) edited = spliceAt(edited, stored[0], key);
	else if (key) edited = spliceAt(edited, '</authEncryption>', `</authEncryption>${key}`);
	return spliceAt(xml, security[0], edited);
}

/** Replace the first occurrence of `find` with `insert`, taking `insert` literally. */
function spliceAt(text: string, find: string, insert: string): string {
	const at = text.indexOf(find);
	return at < 0 ? text : text.slice(0, at) + insert + text.slice(at + find.length);
}

/**
 * A WLAN profile document for one network.
 *
 * Windows will not associate with a network it has no profile for, and a profile
 * is only expressible as this XML — there is no struct form. An empty password
 * produces an open-network profile.
 *
 * `sae` selects WPA3-Personal instead of WPA2. It is not a preference but a
 * requirement of the access point: a WPA3-only network refuses a WPA2PSK profile
 * and a WPA2 network refuses a WPA3SAE one, so the caller passes what the scan
 * said the network actually uses.
 *
 * A NEW profile is written `manual`: the user is never asked - the UI offers
 * Connect and nothing else - so an explicit single join to a guest or conference
 * network must not silently change the machine's long-term behaviour, up to and
 * including auto-joining an open network of that name anywhere in the world. A
 * "remember this network" option would be the way to offer the other mode.
 *
 * Replacing an EXISTING profile never goes through here: that path edits the
 * stored document instead, so the mode the user chose in Windows - and
 * everything else it carries - stays exactly as it was.
 *
 * ponytail: WPA2PSK and WPA3SAE cover personal networks, including the WPA2/WPA3
 * transition mode consumer access points ship with (which advertises itself as
 * WPA2 and accepts the WPA2 profile). Enterprise 802.1X and OWE "enhanced open"
 * are not covered — those fail with a reason code from Windows rather than
 * silently doing nothing, and would need their own profile shapes.
 */
export function windowsWifiProfileXml(profileName: string, ssidBytes: Uint8Array, password: string, sae: boolean = false): string {
	// The profile name and the SSID are two different things. Windows keeps them
	// apart — the profile name is a case-sensitive label the user or a policy can
	// change, the SSID is what goes on the air — and writing the SSID into both
	// created a second, competing profile whenever the real one was named anything
	// else.
	const name = escapeXml(profileName);
	// The SSID goes in as `<hex>` rather than `<name>`, because an SSID is a byte
	// sequence and is not guaranteed to be UTF-8. Round-tripping it through text
	// replaces every undecodable octet with U+FFFD, and the profile would then
	// target a network that does not exist. `<hex>` is authoritative and `<name>`
	// is ignored when it is present, so only the hex form is emitted.
	const hex = ssidHex(ssidBytes);
	const security = joinSecurityElement(password, sae);
	return `<?xml version="1.0"?><WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1"><name>${name}</name><SSIDConfig><SSID><hex>${hex}</hex></SSID></SSIDConfig><connectionType>ESS</connectionType><connectionMode>manual</connectionMode><MSM><security>${security}</security></MSM></WLANProfile>`;
}

/**
 * Refuse a credential the chosen mechanism or the Windows profile schema could
 * not accept, before anything is written.
 *
 * Two constraints the shared validator cannot apply. It does not know whether
 * this access point runs WPA3 SAE, where a raw 64-hex PSK is written, accepted
 * and then simply never authenticates. And the Microsoft profile schema is
 * narrower than 802.11i: `passPhrase` key material is 8 to 63 PRINTABLE ASCII
 * characters, so a passphrase carrying an accented letter is refused by
 * WlanSetProfile with an opaque reason code rather than by anything that can
 * explain itself — and on Windows the profile is written BEFORE the association
 * is attempted, so that refusal comes after a working profile was replaced.
 */
export function assertWindowsWifiKey(password: string, sae: boolean): void {
	if (isWifiHexKey(password)) {
		if (sae) throw new Error('this network uses WPA3, which takes a passphrase rather than a raw 64-digit key');
		return;
	}
	// The Microsoft profile schema, not the 802.11 rule the shared validator
	// applies: `passPhrase` key material is 8 to 63 PRINTABLE ASCII characters, and
	// that holds for WPA3SAE here as much as for WPA2PSK. NetworkManager sets no
	// length for SAE — measured — which is why this cannot live in the shared
	// check. Refused here it is refused before anything is written; refused by
	// WlanSetProfile it comes back as an opaque reason code, after a working
	// profile has already been replaced.
	if (!/^[\x20-\x7e]+$/.test(password)) throw new Error('Windows accepts only printable ASCII characters in a Wi-Fi passphrase');
	if (password.length < 8 || password.length > 63) throw new Error('Windows saves a Wi-Fi passphrase of 8 to 63 characters');
}

/** A stored WLAN profile, as {@link readStoredProfile} found it. */
export interface StoredProfile {
	/** The document exactly as Windows holds it, key material still encrypted. */
	readonly xml: string;
	/** WLAN_PROFILE_* flags. Writing it back with any others changes its scope. */
	readonly flags: number;
	/**
	 * The opaque per-profile blob another WLAN client may keep beside this profile,
	 * or null when it keeps none.
	 *
	 * Windows stores it separately from the document and DISCARDS it whenever the
	 * document is rewritten with different content — measured on Windows 11: an
	 * identical `WlanSetProfile` leaves it alone, one that changes the profile (which
	 * every join does, because it writes the key the user just typed) drops it, and
	 * a delete takes it with the profile. It belongs to whoever wrote it — enterprise
	 * provisioning, a vendor's connection manager — and this app has no way to
	 * reconstruct it, so the only honest thing is to hand it back.
	 */
	readonly customUserData: Uint8Array | null;
}

/**
 * What {@link readStoredProfile} found: the profile, its PROVABLE absence, or a
 * failure that is neither.
 *
 * The third case is the whole reason this is a union rather than a nullable
 * profile. `WlanGetProfile` answers ERROR_NOT_FOUND for a name Windows holds
 * nothing under, but it also answers access-denied, an invalid handle, out of
 * memory and RPC failures — and collapsing all of those to `null` told the caller
 * the profile did not exist. It then overwrote a profile it had no backup of and,
 * on failure, DELETED one it had never created.
 */
export type StoredProfileResult = { readonly kind: 'found'; readonly profile: StoredProfile } | { readonly kind: 'notFound' } | { readonly kind: 'error'; readonly message: string };

/**
 * The stored profile for one profile name.
 *
 * The key material comes back encrypted (reading it in the clear needs elevation
 * this app does not have), which is exactly what a restore needs: the same user
 * on the same machine can hand that ciphertext straight back, so the saved key
 * survives without ever being seen.
 *
 * The flags matter as much as the document. `WlanGetProfile` reports whether the
 * profile is all-user, per-user or pushed by group policy, and those are not
 * interchangeable — a per-user profile written back as all-user is a different
 * object, and a policy profile must not be touched at all.
 *
 * Only ERROR_NOT_FOUND is absence. A success that hands back a null document is
 * an error too: there is then nothing to restore from, which is exactly the
 * situation the caller must not proceed into.
 *
 * A custom-data blob that could not be READ makes the whole reading an error, for
 * the same reason. Every caller of this either overwrites the profile or decides
 * whether the profile is still its own, and both need a snapshot they can hand
 * back; "the document, and no idea about the blob beside it" is not one.
 */
export function readStoredProfile(api: WlanApi, handle: WlanHandle, guidBytes: Uint8Array, profileName: string): StoredProfileResult {
	const name = utf16z(profileName);
	const xmlOut = new BigUint64Array(1);
	// In/out: zero asks for the profile as stored, without the plaintext key.
	const flags = new Uint32Array(1);
	const rc = api.WlanGetProfile(handle, ptr(guidBytes), ptr(name), null, ptr(xmlOut), ptr(flags), null);
	if (rc === ERROR_NOT_FOUND) return { kind: 'notFound' };
	if (rc !== 0) return { kind: 'error', message: wlanErrorMessage(rc) };
	if (xmlOut[0] === 0n) return { kind: 'error', message: 'the WLAN service reported a saved profile but returned no document for it' };
	const xmlPointer = Number(xmlOut[0]) as Pointer;
	try {
		const custom = readProfileCustomUserData(api, handle, guidBytes, name);
		if (custom.kind === 'error') return { kind: 'error', message: `the data another program stores with this network could not be read (${custom.message})` };
		return { kind: 'found', profile: { xml: readUtf16z(xmlPointer), flags: flags[0] ?? 0, customUserData: custom.kind === 'found' ? custom.data : null } };
	} catch (err) {
		// A document that cannot be read back is a document that cannot be restored.
		return { kind: 'error', message: (err as Error).message };
	} finally {
		api.WlanFreeMemory(xmlPointer);
	}
}

/**
 * What reading a profile's custom user data established: the blob, its PROVABLE
 * absence, or a failure that is neither.
 *
 * A union for the same reason {@link StoredProfileResult} is one. Every non-zero
 * code used to read as "there is none", so `ERROR_INVALID_HANDLE`,
 * `ERROR_INVALID_PARAMETER`, an access denial and an RPC failure all reported the
 * same thing an empty profile does. The consequence was not symmetrical with the
 * profile document's: on the overwrite path the caller then wrote its own profile,
 * destroying a blob it had no copy of, and reported the join a success; on the
 * rollback path it reported the data restored when it had never been read.
 */
type CustomDataResult = { readonly kind: 'none' } | { readonly kind: 'found'; readonly data: Uint8Array } | { readonly kind: 'error'; readonly message: string };

/**
 * The custom user data stored against one profile.
 *
 * Only ERROR_FILE_NOT_FOUND is an absence — see {@link ERROR_FILE_NOT_FOUND}. A
 * clean read that hands back nothing is one too: there is then provably no blob to
 * lose.
 *
 * `name` is the already-encoded profile name, because every caller has one.
 */
function readProfileCustomUserData(api: WlanApi, handle: WlanHandle, guidBytes: Uint8Array, name: Uint16Array): CustomDataResult {
	const size = new Uint32Array(1);
	const dataOut = new BigUint64Array(1);
	const rc = api.WlanGetProfileCustomUserData(handle, ptr(guidBytes), ptr(name), null, ptr(size), ptr(dataOut));
	if (rc === ERROR_FILE_NOT_FOUND) return { kind: 'none' };
	if (rc !== 0) return { kind: 'error', message: wlanErrorMessage(rc) };
	const length = size[0] ?? 0;
	if (dataOut[0] === 0n || length === 0) return { kind: 'none' };
	const pointer = Number(dataOut[0]) as Pointer;
	try {
		// Copied out before the buffer is freed — a view over freed memory is not data.
		return { kind: 'found', data: new Uint8Array(toArrayBuffer(pointer, 0, length)).slice() };
	} finally {
		api.WlanFreeMemory(pointer);
	}
}

/**
 * Put somebody else's custom user data back after this attempt rewrote the profile
 * out from under it, and say whether that worked.
 *
 * The return code used to be discarded on the grounds that the write which lost the
 * data had already happened, so failing here would report a failure for a join that
 * worked. That holds on the ROLLBACK path and nowhere else. On the overwrite path
 * this runs inside {@link writeJoinProfile}, before the association is even
 * attempted — so a failure there can be reported honestly, the original profile put
 * back, and no connection made. `WlanSetProfileCustomUserData` has its own ways to
 * fail (a removed USB adapter, a handle that has gone stale), and silently losing
 * another program's data is not something to report as success.
 *
 * Nothing is written when the snapshot found no data: there is then nothing to
 * lose, and a zero-length write is a clear rather than a no-op.
 */
function restoreProfileCustomUserData(api: WlanApi, handle: WlanHandle, guidBytes: Uint8Array, name: Uint16Array, data: Uint8Array | null): string | null {
	if (!data || data.length === 0) return null;
	const rc = api.WlanSetProfileCustomUserData(handle, ptr(guidBytes), ptr(name), data.length, ptr(data), null);
	return rc === 0 ? null : wlanErrorMessage(rc);
}

/** What one attempt did to the stored profiles, so the rollback knows what to undo. */
export interface ProfileChange {
	/** The profile this attempt overwrote, or null when it created one. */
	readonly replaced: StoredProfile | null;
	/** True when nothing was stored under this name before this attempt. */
	readonly created: boolean;
	/**
	 * What Windows held under this name immediately AFTER the write — this
	 * attempt's fingerprint on the profile store, and the only evidence the
	 * rollback has that the profile it is about to touch is still its own.
	 *
	 * Not the document that was written: Windows normalizes what it is given and
	 * stores the key material encrypted, so the two never match. Read back instead,
	 * through the same call the rollback uses, so the comparison is like for like.
	 * Null when that read-back failed, which leaves the rollback unable to prove
	 * ownership and so unwilling to act.
	 */
	readonly written: StoredProfile | null;
}

/** What a join is trying to write, and to which network. */
export interface JoinTarget {
	/** The SSID as uppercase hex — the only unambiguous statement of which network this is. */
	readonly ssidHex: string;
	readonly password: string;
	readonly sae: boolean;
	/** The document to write when this network has no profile yet. */
	newProfile(): string;
}

/**
 * Refuse a stored profile that belongs to a different network.
 *
 * A profile NAME is not a network: Windows lets the two differ, and this app
 * falls back to the SSID for the name when the scan names no profile. Both the
 * write and the connect address the profile BY NAME, so without this a saved
 * "Cafe" pointing at another SSID would be overwritten by one join and used to
 * associate by another - `WlanConnect` takes the networks from the profile it is
 * given, not from the name it was asked for.
 */
function assertProfileIsForNetwork(xml: string, target: JoinTarget): void {
	if (profileSsidHex(xml) !== target.ssidHex) throw new Error('a different network is already saved under this name in Windows, so this one was not joined');
}

/**
 * What an open-network join should do about the profile stored under this name:
 * use it, or create one.
 *
 * A decision of its own because the branch it drives is pure FFI on both sides,
 * which is how it came to skip the ownership check the keyed branch had. Throws
 * rather than returning a third case: neither an unreadable profile nor one
 * belonging to another network leaves anything safe to do.
 */
export function openJoinDecision(stored: StoredProfileResult, target: JoinTarget): 'connect' | 'create' {
	if (stored.kind === 'error') throw new Error(`the saved configuration of this network could not be read, so it was not joined (${stored.message})`);
	if (stored.kind === 'notFound') return 'create';
	assertProfileIsForNetwork(stored.profile.xml, target);
	return 'connect';
}

/**
 * Write the profile a keyed join needs, and report what that did to what Windows
 * already held.
 *
 * Read before overwriting: the typed key may be wrong, and the profile being
 * replaced may be the working one the user has had for years. The FLAGS come back
 * with it, because restoring an all-user or a per-user profile as flags 0 changes
 * its scope — a different profile in all but name, and a rollback that fails for
 * that reason alone.
 *
 * The absent case is where the race lives. Between the read that found nothing
 * and the write, another process — a second client of this app, netsh, the
 * Windows UI, a policy refresh — can save a profile under that name. Writing with
 * `bOverwrite` TRUE would replace it and, because this attempt believed it had
 * CREATED the profile, a later rollback would DELETE a network the user had just
 * saved. So the first write asks not to overwrite: ERROR_ALREADY_EXISTS is
 * Windows answering that the absence no longer holds, and the profile that
 * appeared is then read, backed up and overwritten like any other existing one.
 */
export function writeJoinProfile(api: WlanApi, handle: WlanHandle, guidBytes: Uint8Array, profileName: string, target: JoinTarget): ProfileChange {
	const stored = readStoredProfile(api, handle, guidBytes, profileName);
	// A read that FAILED is not a read that found nothing. Proceeding on one would
	// overwrite a profile with no backup taken, and the rollback would then delete
	// a network the user had saved for years. Only a provable absence lets this
	// attempt create a profile of its own.
	if (stored.kind === 'error') throw new Error(`the saved configuration of this network could not be read, so it will not be replaced (${stored.message})`);
	if (stored.kind === 'found') return overwrite(stored.profile);
	// Believed absent — and asking not to overwrite is what makes that belief
	// checkable rather than merely assumed. Anything but ERROR_ALREADY_EXISTS means
	// the write landed on the empty name it was aimed at.
	if (writeProfile(api, handle, guidBytes, target.newProfile(), WLAN_PROFILE_USER, 0) !== ERROR_ALREADY_EXISTS) return { replaced: null, created: true, written: readWrittenProfile(api, handle, guidBytes, profileName) };
	const raced = readStoredProfile(api, handle, guidBytes, profileName);
	// It existed a moment ago and cannot be read now: there is a profile here that
	// this attempt cannot back up, so it does not touch it.
	if (raced.kind !== 'found') throw new Error('another process saved a profile for this network while it was being joined, and it could not be read');
	return overwrite(raced.profile);

	/**
	 * Replace an existing profile, keeping its scope. A new one would be created
	 * per-user instead: creating one for every account on the machine needs a
	 * privilege the Wi-Fi capability never established, and a one-off join has no
	 * business reaching outside this account.
	 */
	function overwrite(existing: StoredProfile): ProfileChange {
		// A group-policy profile is not this app's to replace. The overwrite is
		// refused on most hosts, and where it is not, nothing here can put a policy
		// profile back afterwards.
		if ((existing.flags & WLAN_PROFILE_GROUP_POLICY) !== 0) throw new Error('this network is managed by group policy and cannot be changed here');
		// A profile NAME is not a network. Windows lets the two differ, so a stored
		// profile called the same thing as the network being joined may belong to a
		// completely different SSID — and overwriting it destroys that network's
		// saved configuration on SUCCESS, where nothing rolls anything back.
		assertProfileIsForNetwork(existing.xml, target);
		// Only the credentials change. Regenerating the document kept the SSID and
		// the key and dropped everything else the user had set on this profile.
		const edited = withJoinCredentials(existing.xml, target.password, target.sae);
		if (edited === null) throw new Error('the saved configuration of this network is not in a shape this app can edit, so it was left alone');
		writeProfile(api, handle, guidBytes, edited, existing.flags, 1);
		// The write just discarded whatever another WLAN client kept beside this
		// profile — see StoredProfile.customUserData. Replacing the credentials is
		// what the user asked for; destroying somebody else's metadata is not, so it
		// goes straight back, before the fingerprint is taken.
		const lost = restoreProfileCustomUserData(api, handle, guidBytes, utf16z(profileName), existing.customUserData);
		// Nothing has been connected yet, so this failure is one that can still be
		// answered honestly: put the document back as it was and stop. Carrying on
		// would associate successfully and report a join that had quietly destroyed
		// another program's data.
		if (lost) throw new Error(`the data another program stores with this network could not be put back, so this network was not joined (${lost})${describeRestore(writeStoredProfile(api, handle, guidBytes, profileName, existing))}`);
		return { replaced: existing, created: false, written: readWrittenProfile(api, handle, guidBytes, profileName) };
	}
}

/**
 * The profile as Windows holds it right after a write — see
 * {@link ProfileChange.written}.
 *
 * Anything but a clean read yields null rather than an error: the write itself
 * succeeded, so failing the join over a fingerprint that could not be taken would
 * report a failure that did not happen. What it costs instead is the rollback's
 * ability to prove the profile is still its own, which that path answers for
 * itself.
 */
export function readWrittenProfile(api: WlanApi, handle: WlanHandle, guidBytes: Uint8Array, profileName: string): StoredProfile | null {
	const stored = readStoredProfile(api, handle, guidBytes, profileName);
	return stored.kind === 'found' ? stored.profile : null;
}

/**
 * Put a snapshotted profile back exactly as it was, document, scope and the data
 * another program stores beside it, and report what went wrong rather than throwing.
 *
 * Shared by the two paths that undo a write — the overwrite giving up because the
 * custom data could not be handed back, and the rollback after a failed
 * association — because "restore this profile" means the same thing in both, and
 * restoring only the document leaves half the object behind.
 */
function writeStoredProfile(api: WlanApi, handle: WlanHandle, guidBytes: Uint8Array, profileName: string, profile: StoredProfile): string | null {
	const name = utf16z(profileName);
	const document = utf16z(profile.xml);
	const reason = new Uint32Array(1);
	const rc = api.WlanSetProfile(handle, ptr(guidBytes), profile.flags, ptr(document), null, 1, null, ptr(reason));
	if (rc !== 0) return `the previous profile could not be restored (${describeProfileFailure(api, rc, reason[0] ?? 0)})`;
	// That WlanSetProfile discarded the custom data again, exactly as the write being
	// undone did, so it goes back too — and a failure here is reported rather than
	// swallowed, because the restore is then only partly done.
	const lost = restoreProfileCustomUserData(api, handle, guidBytes, name, profile.customUserData);
	return lost ? `the previous profile was restored but the data another program stores with it was not (${lost})` : null;
}

/** A restore outcome as a clause to append to an error, or nothing when it worked. */
function describeRestore(failure: string | null): string {
	return failure ? ` — and ${failure}` : '';
}

/**
 * Whether two custom-data snapshots are the same blob, BY CONTENT.
 *
 * Reference equality would answer no to two identical reads, since each one copies
 * the bytes out of a buffer the WLAN service then frees — so the fingerprint would
 * report a conflict on every profile that has custom data at all.
 */
function sameCustomUserData(a: Uint8Array | null, b: Uint8Array | null): boolean {
	if (a === null || b === null) return a === b;
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Write a profile document, turning a refusal into an error that carries the
 * reason code. Returns the raw result so the caller can tell the one tolerable
 * outcome — ERROR_ALREADY_EXISTS after asking not to overwrite — from a failure.
 */
export function writeProfile(api: WlanApi, handle: WlanHandle, guidBytes: Uint8Array, profileXml: string, flags: number, overwrite: 0 | 1): number {
	const document = utf16z(profileXml);
	const reason = new Uint32Array(1);
	const rc = api.WlanSetProfile(handle, ptr(guidBytes), flags, ptr(document), null, overwrite, null, ptr(reason));
	// ERROR_ALREADY_EXISTS is an answer to a CREATE: it says the name was taken, and
	// the caller decides what to do about that. Answered to an overwrite it means
	// Windows did not write - documented for a profile whose scope has changed since
	// it was read - and tolerating it there reported a password as saved that was
	// never stored, then went on to associate through the old profile and call that
	// success.
	if (rc !== 0 && !(overwrite === 0 && rc === ERROR_ALREADY_EXISTS)) throw new Error(describeProfileFailure(api, rc, reason[0] ?? 0));
	return rc;
}

/**
 * Undo what the failed attempt wrote — but only while the profile is still the
 * one it wrote.
 *
 * The two undo actions are different, not one with a null in it. A profile this
 * attempt CREATED has to be deleted — "restoring what was there before" would
 * mean writing nothing and leaving the new one standing, which is how a failed
 * join used to leave a dead profile behind. A profile it OVERWROTE goes back with
 * the flags it had, so its scope is unchanged.
 *
 * What both share is that they are only correct if nobody else has touched the
 * profile in the meantime, and up to twenty seconds pass between the write and
 * the rollback while the adapter tries to associate. The host mutex covers this
 * process and nothing else: the Windows network UI, `netsh`, a group policy
 * refresh, the Network List Manager and a second instance of this app can all
 * save a profile under that name inside that window. Deleting or overwriting
 * unconditionally would then discard a change the user had just made — the same
 * hazard the write path already refuses, arriving from the other end.
 *
 * So the profile is re-read and compared against {@link ProfileChange.written},
 * the fingerprint taken right after the write. Equal means it is still ours and
 * the undo runs. Anything else — changed, removed, or a fingerprint that could
 * not be taken — means the third party's version stands and this reports the
 * conflict instead of resolving it.
 *
 * ALL THREE parts of the fingerprint are compared, the custom user data included.
 * Comparing only the document and the flags left the one part another WLAN client
 * can change on its own out of the test: during the same twenty-second window a
 * vendor's connection manager can write its blob and touch nothing else, and the
 * rollback then judged the profile still its own — deleting the newly created
 * profile along with the foreign blob, or overwriting the profile and putting the
 * older blob back over the newer one. (This is not the deferred race between two
 * adjacent wlanapi calls; it is the long window this whole function exists for.)
 *
 * The one exception is a profile this attempt created that has since been
 * deleted: the undo's whole goal was for it not to exist, and it does not.
 */
export function undoProfileChange(api: WlanApi, handle: WlanHandle, guidBytes: Uint8Array, profileName: string, change: ProfileChange): string | null {
	if (!change.written) return 'what this attempt saved for this network could not be read back, so its configuration was left as it stands';
	const current = readStoredProfile(api, handle, guidBytes, profileName);
	if (current.kind === 'error') return `this network's saved configuration could not be re-read, so it was left as it stands (${current.message})`;
	if (current.kind === 'notFound') return change.created ? null : 'another process removed this network while it was being joined, so the previous configuration was not put back';
	if (current.profile.xml !== change.written.xml || current.profile.flags !== change.written.flags || !sameCustomUserData(current.profile.customUserData, change.written.customUserData)) return 'another process changed this network while it was being joined, so its configuration was left as it stands';
	const name = utf16z(profileName);
	if (change.created) {
		const rc = api.WlanDeleteProfile(handle, ptr(guidBytes), ptr(name), null);
		return rc === 0 ? null : `the profile this attempt created could not be deleted (${wlanErrorMessage(rc)})`;
	}
	return writeStoredProfile(api, handle, guidBytes, profileName, change.replaced as StoredProfile);
}

/** {@link undoProfileChange} on a handle of its own — the one used for the join is long closed by the time an association times out. */
export function undoWifiProfileChange(guidBytes: Uint8Array, profileName: string, change: ProfileChange | null): string | null {
	if (!change || (!change.created && !change.replaced)) return null;
	try {
		return withWlanHandle((api, handle) => undoProfileChange(api, handle, guidBytes, profileName, change));
	} catch (err) {
		return `the WLAN service could not be reached to undo it (${(err as Error).message})`;
	}
}
