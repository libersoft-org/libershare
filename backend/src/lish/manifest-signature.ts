import type { PrivateKey } from '@libp2p/interface';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';
import { CodedError, ErrorCodes, LISH_FORMAT_VERSION, decodeSignature, encodeSignature, isSignedLISH, signedManifestBytes, validateSignedLISHShape, type ILISH } from '@shared';
import { deriveLISHID, lishIDMatchesPublisher, newLISHNonce } from './lish-id.ts';

/** Outcome of checking a manifest's optional publisher signature. */
export type ManifestSignatureState = { readonly signed: false } | { readonly signed: true; readonly publisher: string };

function invalid(detail: string): never {
	throw new CodedError(ErrorCodes.LISH_INVALID_SIGNATURE, detail);
}

/**
 * Sign a manifest as its publisher. Signing gives the manifest the ID derived from the key and
 * the nonce, so the ID it had before is gone; the result is in the current format.
 */
export async function signManifestAs(key: PrivateKey, lish: ILISH, nonce: string = newLISHNonce()): Promise<ILISH> {
	const { signature: _old, ...unsigned } = lish;
	const publisher = peerIdFromPrivateKey(key).toString();
	const signed: ILISH = { ...unsigned, version: LISH_FORMAT_VERSION, id: deriveLISHID(publisher, nonce), publisher, nonce };
	return { ...signed, signature: encodeSignature(await key.sign(signedManifestBytes(signed))) };
}

/**
 * Verify the optional Ed25519 signature of a manifest against the public key embedded in its
 * `publisher` Peer ID. An unsigned manifest is valid and reported as such; a manifest that claims
 * a signature must carry a canonical Ed25519 Peer ID, a signature over the exact signed bytes and
 * the ID that Peer ID derives.
 */
export async function verifyManifestSignature(lish: ILISH): Promise<ManifestSignatureState> {
	if (!isSignedLISH(lish)) return { signed: false };
	validateSignedLISHShape(lish);
	let peerID;
	try {
		peerID = peerIdFromString(lish.publisher!);
	} catch {
		invalid('publisher is not a Peer ID');
	}
	// The publisher string is part of the signed bytes, so only its one canonical spelling counts.
	if (peerID.toString() !== lish.publisher) invalid('publisher is not in canonical form');
	if (peerID.type !== 'Ed25519' || !peerID.publicKey) invalid('publisher key is not Ed25519');
	const ok = await peerID.publicKey.verify(signedManifestBytes(lish), decodeSignature(lish.signature!));
	if (!ok) invalid('signature does not match the manifest');
	// A valid signature under an ID made for another key: the signer took over someone else's ID.
	if (!lishIDMatchesPublisher(lish)) throw new CodedError(ErrorCodes.LISH_ID_MISMATCH, `${lish.id} is not an ID of ${lish.publisher}`);
	return { signed: true, publisher: lish.publisher! };
}

/**
 * Publisher a manifest must carry: `string` for a known publisher, `null` for an explicitly
 * unsigned one, `undefined` when nothing is known yet.
 */
export type ExpectedPublisher = string | null | undefined;

/** Throw `LISH_PUBLISHER_MISMATCH` when the verified state does not match the expectation. */
export function assertExpectedPublisher(state: ManifestSignatureState, expected: ExpectedPublisher): void {
	if (expected === undefined) return;
	const actual = state.signed ? state.publisher : null;
	if (actual !== expected) throw new CodedError(ErrorCodes.LISH_PUBLISHER_MISMATCH, `expected ${expected ?? 'unsigned'}, got ${actual ?? 'unsigned'}`);
}
