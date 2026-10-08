import { CodedError, ErrorCodes } from './errors.ts';
import { formatUntrustedValue } from './untrusted-value.ts';
import type { IDirectoryEntry, IFileEntry, ILinkEntry, ILISH } from './lish.ts';

/**
 * Domain prefix of every signed manifest. A signature over these bytes cannot be replayed as a
 * signature over anything else the node key signs (libp2p handshakes, future catalog events).
 */
export const LISH_SIGNATURE_DOMAIN = 'libershare/lish-manifest/v1\n';

const ROOT_FIELDS = new Set(['id', 'publisher', 'signature', 'name', 'description', 'created', 'chunkSize', 'checksumAlgo', 'directories', 'files', 'links', 'directory', 'finalDirectory', 'chunks']);
const DIRECTORY_FIELDS = new Set(['path', 'permissions', 'modified', 'created']);
const FILE_FIELDS = new Set(['path', 'size', 'permissions', 'modified', 'created', 'checksums']);
const LINK_FIELDS = new Set(['path', 'target', 'hardlink', 'modified', 'created']);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const PERMISSIONS = /^[0-7]{1,4}$/;
// Shape only: parsing the Peer ID and checking its key type needs libp2p, which lives in the backend.
const PEER_ID_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{1,128}$/;
const SIGNATURE_SHAPE = /^[A-Za-z0-9_-]{86}$/;

/** Whether the manifest claims a publisher signature (either field present). */
export function isSignedLISH(lish: Pick<ILISH, 'publisher' | 'signature'>): boolean {
	return lish.publisher !== undefined || lish.signature !== undefined;
}

function reject(detail: string): never {
	throw new CodedError(ErrorCodes.LISH_INVALID_MANIFEST, detail);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function hasLoneSurrogate(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			i++;
		} else if (code >= 0xdc00 && code <= 0xdfff) return true;
	}
	return false;
}

function checkFields(where: string, entry: Record<string, unknown>, allowed: Set<string>): void {
	for (const key of Object.keys(entry)) {
		if (!allowed.has(key)) reject(`${where}: field ${formatUntrustedValue(key)} is not allowed in a signed manifest`);
		// An optional field carried as `undefined` (the DB mapper produces those) means "absent".
		const value = entry[key];
		if (value === null) reject(`${where}: field ${key} is null`);
		if (typeof value === 'string' && hasLoneSurrogate(value)) reject(`${where}: field ${key} is not valid Unicode`);
	}
}

function checkOptionalText(where: string, key: string, value: unknown, pattern?: RegExp): void {
	if (value === undefined) return;
	if (typeof value !== 'string' || (pattern && !pattern.test(value))) reject(`${where}: invalid ${key} ${formatUntrustedValue(value)}`);
}

function checkSafeCount(where: string, key: string, value: unknown): void {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) reject(`${where}: invalid ${key}`);
}

/**
 * Strict shape of a signed manifest, on top of {@link validateLISHStructure}. The signed bytes are
 * rebuilt from the stored manifest, so every field must survive SQLite and MessagePack unchanged:
 * no unknown fields, ISO timestamps (a numeric-looking string would come back from a TIMESTAMP
 * column as a number), octal permissions, boolean `hardlink`, plain JSON values only.
 */
export function validateSignedLISHShape(lish: ILISH): void {
	if (!isPlainObject(lish)) reject('signed manifest is not a plain object');
	checkFields('manifest', lish as unknown as Record<string, unknown>, ROOT_FIELDS);
	if (typeof lish.publisher !== 'string' || !PEER_ID_SHAPE.test(lish.publisher)) reject(`invalid publisher ${formatUntrustedValue(lish.publisher)}`);
	if (typeof lish.signature !== 'string' || !SIGNATURE_SHAPE.test(lish.signature)) reject('invalid signature encoding');
	if (typeof lish.created !== 'string' || !TIMESTAMP.test(lish.created)) reject(`invalid created ${formatUntrustedValue(lish.created)}`);
	checkSafeCount('manifest', 'chunkSize', lish.chunkSize);
	for (const [key, list, allowed] of [
		['directory', lish.directories, DIRECTORY_FIELDS],
		['file', lish.files, FILE_FIELDS],
		['link', lish.links, LINK_FIELDS],
	] as const) {
		if (list === undefined) continue;
		if (!Array.isArray(list)) reject(`${key} list is not an array`);
		for (const entry of list as unknown[]) {
			if (!isPlainObject(entry)) reject(`${key} entry is not a plain object`);
			checkFields(key, entry, allowed);
			checkOptionalText(key, 'permissions', entry['permissions'], PERMISSIONS);
			checkOptionalText(key, 'modified', entry['modified'], TIMESTAMP);
			checkOptionalText(key, 'created', entry['created'], TIMESTAMP);
		}
	}
	for (const file of lish.files ?? []) {
		checkSafeCount('file', 'size', file.size);
		if (!Array.isArray(file.checksums) || file.checksums.some(cs => typeof cs !== 'string')) reject('file checksums are not strings');
	}
	for (const link of lish.links ?? []) {
		if (link.hardlink !== undefined && typeof link.hardlink !== 'boolean') reject(`link: invalid hardlink ${formatUntrustedValue(link.hardlink)}`);
	}
}

function directoryPayload(entry: IDirectoryEntry): Record<string, unknown> {
	return withOptional({ path: entry.path }, entry, ['permissions', 'modified', 'created']);
}

function filePayload(entry: IFileEntry): Record<string, unknown> {
	return withOptional({ path: entry.path, size: entry.size, checksums: [...entry.checksums] }, entry, ['permissions', 'modified', 'created']);
}

function linkPayload(entry: ILinkEntry): Record<string, unknown> {
	return withOptional({ path: entry.path, target: entry.target, hardlink: entry.hardlink === true }, entry, ['modified', 'created']);
}

function withOptional(base: Record<string, unknown>, source: object, keys: readonly string[]): Record<string, unknown> {
	for (const key of keys) {
		const value = (source as Record<string, unknown>)[key];
		if (value !== undefined) base[key] = value;
	}
	return base;
}

/**
 * The object the publisher signs: the whole manifest without `signature` and without the
 * node-local fields, normalized so the copy rebuilt from the database yields the same bytes
 * (collections always present, `hardlink` always boolean, empty name/description absent).
 * Item order is kept exactly; only object keys are ordered, by the canonical encoder.
 */
export function signedManifestPayload(lish: ILISH): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		id: lish.id,
		publisher: lish.publisher,
		created: lish.created,
		chunkSize: lish.chunkSize,
		checksumAlgo: lish.checksumAlgo,
		directories: (lish.directories ?? []).map(directoryPayload),
		files: (lish.files ?? []).map(filePayload),
		links: (lish.links ?? []).map(linkPayload),
	};
	if (lish.name) payload['name'] = lish.name;
	if (lish.description) payload['description'] = lish.description;
	return payload;
}

/**
 * Canonical JSON for the value domain of a signed manifest: plain objects, arrays, strings
 * without lone surrogates, safe integers and booleans. Keys sort by UTF-16 code units and values
 * use the JSON serialization, which for this domain is byte-identical to RFC 8785.
 */
export function canonicalJSON(value: unknown): string {
	if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value)) throw new Error('canonical JSON accepts only safe integers');
		return String(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
	if (isPlainObject(value)) {
		const keys = Object.keys(value)
			.filter(key => value[key] !== undefined)
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
	}
	throw new Error(`canonical JSON cannot encode ${typeof value}`);
}

/** Exact bytes signed by the publisher and checked by every receiver. */
export function signedManifestBytes(lish: ILISH): Uint8Array {
	return new TextEncoder().encode(LISH_SIGNATURE_DOMAIN + canonicalJSON(signedManifestPayload(lish)));
}

/** Base64url without padding, the wire form of a signature. */
export function encodeSignature(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Inverse of {@link encodeSignature}; throws a coded error on a malformed value. */
export function decodeSignature(text: string): Uint8Array {
	if (!SIGNATURE_SHAPE.test(text)) reject('invalid signature encoding');
	const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==');
	return Uint8Array.from(binary, char => char.charCodeAt(0));
}
