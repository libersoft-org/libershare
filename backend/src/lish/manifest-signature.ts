import type { PrivateKey } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { LISH_FORMAT_VERSION, encodeSignature, signedManifestBytes, type ILISH } from '@shared';
import { deriveLISHID, newLISHNonce } from './lish-id.ts';

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
