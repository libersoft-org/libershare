import { describe, expect, it } from 'bun:test';
import { generateKeyPair, generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { ErrorCodes, type ILISH } from '@shared';
import { Network } from '../../../src/protocol/network.ts';
import { verifyManifestSignature } from '../../../src/lish/manifest-signature.ts';

/** `signManifest` runs on the live identity; a stand-in `this` supplies just that state. */
function signWith(state: { node: unknown; currentPrivateKey: unknown; lifecycle?: string }, lish: ILISH): Promise<ILISH> {
	// The same object, not a copy: a test that swaps the identity mid-sign must reach the signer.
	const self = Object.assign(state, { lifecycle: state.lifecycle ?? 'running', isRunning: Network.prototype.isRunning });
	return Network.prototype.signManifest.call(self as never, lish);
}

const manifest = { id: 'a3000000-0000-4000-8000-000000000010', name: 'Item', created: '2026-10-08T10:00:00.000Z', chunkSize: 4, checksumAlgo: 'sha256', files: [{ path: 'a.bin', size: 4, checksums: ['e'.repeat(64)] }] } as ILISH;

describe('Network.signManifest', () => {
	it('signs with the key it read first, even when the identity changes while signing', async () => {
		const first = await generateKeyPairFromSeed(
			'Ed25519',
			Uint8Array.from({ length: 32 }, (_, i) => i + 1)
		);
		const second = await generateKeyPair('Ed25519');
		const state = { node: {}, currentPrivateKey: null as unknown };
		// The identity is replaced in the middle of the signing call.
		state.currentPrivateKey = Object.assign(Object.create(Object.getPrototypeOf(first)), first, {
			sign: async (data: Uint8Array) => {
				state.currentPrivateKey = second;
				return first.sign(data);
			},
		});
		const signed = await signWith(state, manifest);
		expect(signed.publisher).toBe(peerIdFromPrivateKey(first).toString());
		expect(await verifyManifestSignature(signed)).toEqual({ signed: true, publisher: signed.publisher! });
		expect(Object.keys(signed).sort()).toEqual([...Object.keys(manifest), 'publisher', 'signature'].sort());
	});

	it('replaces an earlier signature instead of keeping a stale one', async () => {
		const key = await generateKeyPair('Ed25519');
		const once = await signWith({ node: {}, currentPrivateKey: key }, manifest);
		const again = await signWith({ node: {}, currentPrivateKey: key }, { ...once, name: 'Renamed' });
		expect(await verifyManifestSignature(again)).toEqual({ signed: true, publisher: once.publisher! });
	});

	it('refuses a key type that cannot produce an Ed25519 signature', async () => {
		const rsa = await generateKeyPair('RSA', 1024);
		await expect(signWith({ node: {}, currentPrivateKey: rsa }, manifest)).rejects.toMatchObject({ code: ErrorCodes.LISH_SIGNING_UNSUPPORTED_KEY });
	});

	it('refuses to sign while the network is not running, even with a node and key still present', async () => {
		const key = await generateKeyPair('Ed25519');
		await expect(signWith({ node: null, currentPrivateKey: key }, manifest)).rejects.toMatchObject({ code: ErrorCodes.NETWORK_NOT_RUNNING });
		for (const lifecycle of ['starting', 'stopping', 'failed', 'stopped']) {
			await expect(signWith({ node: {}, currentPrivateKey: key, lifecycle }, manifest)).rejects.toMatchObject({ code: ErrorCodes.NETWORK_NOT_RUNNING });
		}
	});
});
