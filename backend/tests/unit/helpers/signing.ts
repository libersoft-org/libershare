import type { PrivateKey } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { encodeSignature, signedManifestBytes, type ILISH, type LISHChecks, type LISHid } from '@shared';
import { deriveLISHID } from '../../../src/lish/lish-id.ts';
import { signManifestAs } from '../../../src/lish/manifest-signature.ts';

/** The checks of a manifest that passed every one, and of an unsigned one. */
export const VERIFIED: LISHChecks = { signed: true, signatureValid: true, idMatchesPublisher: true };
export const UNSIGNED: LISHChecks = { signed: false };

/** One nonce for every test manifest, so a key always signs under the same ID. */
export const TEST_NONCE = 'AAAAAAAAAAAAAAAAAAAAAA';

/** The ID {@link signFixed} gives a manifest signed by `key`. */
export function fixedIDOf(key: PrivateKey): LISHid {
	return deriveLISHID(peerIdFromPrivateKey(key).toString(), TEST_NONCE) as LISHid;
}

/** Sign as a publisher would, with the fixed nonce. */
export function signFixed(lish: ILISH, key: PrivateKey): Promise<ILISH> {
	return signManifestAs(key, lish, TEST_NONCE);
}

/** A valid signature by `key` over the manifest under the ID it already has, which `key` does not derive. */
export async function signKeepingID(lish: ILISH, key: PrivateKey): Promise<ILISH> {
	const body = { ...lish, version: 1, publisher: peerIdFromPrivateKey(key).toString(), nonce: TEST_NONCE };
	return { ...body, signature: encodeSignature(await key.sign(signedManifestBytes(body))) };
}
