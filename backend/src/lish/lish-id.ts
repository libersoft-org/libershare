import { createHash, randomBytes } from 'node:crypto';
import { isNonceShape, isPublisherShape, type ILISH } from '@shared';

/** A fresh nonce for a manifest about to be signed. */
export function newLISHNonce(): string {
	return randomBytes(16).toString('base64url');
}

/**
 * ID of a signed LISH: a version 8 UUID (RFC 9562) whose 122 free bits are the start of
 * SHA-256 over the publisher Peer ID followed by the nonce, both as the text the manifest carries.
 * The nonce has a fixed length, so the two never run into each other. Anyone can compute an ID
 * for any Peer ID; only that publisher's signature makes a manifest under it count.
 */
export function deriveLISHID(publisher: string, nonce: string): string {
	const hash = createHash('sha256')
		.update(publisher + nonce, 'utf8')
		.digest();
	hash[6] = (hash[6]! & 0x0f) | 0x80;
	hash[8] = (hash[8]! & 0x3f) | 0x80;
	const hex = hash.subarray(0, 16).toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Whether the manifest's ID is the one its `publisher` and `nonce` derive. */
export function lishIDMatchesPublisher(lish: Pick<ILISH, 'id' | 'publisher' | 'nonce'>): boolean {
	return isPublisherShape(lish.publisher) && isNonceShape(lish.nonce) && lish.id === deriveLISHID(lish.publisher, lish.nonce);
}
