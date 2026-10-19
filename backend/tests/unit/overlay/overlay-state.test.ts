import { describe, expect, it } from 'bun:test';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { type OverlayState } from '@shared';
import { applyState, nextVersion, signState, verifyState } from '../../../src/overlay/overlay-state.ts';

const NET = 'net-1';
const SUBNET = '100.64.0.0/16';

/** A CA key in Nebula's PEM form (ed25519, 64 raw bytes) and its public key as hex. */
async function caKey(): Promise<{ pem: string; publicHex: string }> {
	const key = await generateKeyPair('Ed25519');
	const pem = `-----BEGIN NEBULA ED25519 PRIVATE KEY-----\n${Buffer.from(key.raw).toString('base64')}\n-----END NEBULA ED25519 PRIVATE KEY-----\n`;
	return { pem, publicHex: Buffer.from(key.publicKey.raw).toString('hex') };
}

const state: OverlayState = { networkID: NET, version: 5, lighthouses: [{ vpnIP: '100.64.0.1', addr: '203.0.113.7:4242' }], relays: [{ vpnIP: '100.64.0.1', addr: '203.0.113.7:4242' }], revoked: ['ab'.repeat(32)] };

describe('signed overlay state', () => {
	it('verifies against the CA that signed it', async () => {
		const ca = await caKey();
		const signed = await signState(state, ca.pem);
		expect(await verifyState(signed, ca.publicHex, NET, SUBNET)).toEqual(state);
	});

	it('refuses another CA, a tampered state, another lishnet and hosts outside the subnet', async () => {
		const ca = await caKey();
		const other = await caKey();
		const signed = await signState(state, ca.pem);
		await expect(verifyState(signed, other.publicHex, NET, SUBNET)).rejects.toThrow('not signed by');
		await expect(verifyState({ ...signed, state: signed.state.replace('"version":5', '"version":6') }, ca.publicHex, NET, SUBNET)).rejects.toThrow('not signed by');
		await expect(verifyState(signed, ca.publicHex, 'net-2', SUBNET)).rejects.toThrow('another lishnet');
		const outside = await signState({ ...state, relays: [{ vpnIP: '10.0.0.1', addr: '203.0.113.7:4242' }] }, ca.pem);
		await expect(verifyState(outside, ca.publicHex, NET, SUBNET)).rejects.toThrow('not in');
		const badRevocation = await signState({ ...state, revoked: ['nope'] }, ca.pem);
		await expect(verifyState(badRevocation, ca.publicHex, NET, SUBNET)).rejects.toThrow('fingerprints');
	});

	it('carries revoked members by peer ID and refuses malformed ones', async () => {
		const ca = await caKey();
		const peer = '12D3KooWGzBgW1mHp7DpLbR2X5yfDN8dRtVYWNw2wXxu3yi1fYM5';
		const withPeers = { ...state, revokedPeers: { [peer]: '2026-10-19T10:00:00.000Z' } };
		expect(await verifyState(await signState(withPeers, ca.pem), ca.publicHex, NET, SUBNET)).toEqual(withPeers);
		await expect(verifyState(await signState({ ...state, revokedPeers: { 'not a peer id': '2026-10-19T10:00:00Z' } } as any, ca.pem), ca.publicHex, NET, SUBNET)).rejects.toThrow('member revocations');
		await expect(verifyState(await signState({ ...state, revokedPeers: { [peer]: 'whenever' } } as any, ca.pem), ca.publicHex, NET, SUBNET)).rejects.toThrow('member revocations');
	});

	it('cannot pass for a signature over the bare JSON (domain separated)', async () => {
		const ca = await caKey();
		const key = await generateKeyPair('Ed25519');
		const forged = { state: JSON.stringify(state), signature: Buffer.from(await key.sign(new TextEncoder().encode(JSON.stringify(state)))).toString('hex') };
		await expect(verifyState(forged, Buffer.from(key.publicKey.raw).toString('hex'), NET, SUBNET)).rejects.toThrow('not signed by');
		expect(ca.publicHex).toHaveLength(64);
	});

	it('applies hosts and version to a definition and keeps versions increasing', () => {
		const definition = { type: 'nebula' as const, caCert: 'x', subnet: SUBNET, lighthouses: [], relays: [], lanDirect: true, version: 0 };
		expect(applyState(definition, state)).toEqual({ ...definition, lighthouses: state.lighthouses, relays: state.relays, version: 5 });
		expect(nextVersion(5)).toBeGreaterThan(5);
		const far = Date.now() + 1e9;
		expect(nextVersion(far)).toBe(far + 1);
	});
});
