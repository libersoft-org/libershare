import { describe, test, expect } from 'bun:test';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { signCatalogOp, verifyCatalogOp, type SignedCatalogOp } from '../catalog-signer.ts';
import { hlcCompare, type HLC } from '../catalog-hlc.ts';

describe('signCatalogOp + verifyCatalogOp', () => {
	test('sign and verify round-trip', async () => {
		const key = await generateKeyPair('Ed25519');
		const clock: HLC = { wallTime: Date.now(), logical: 0, nodeID: 'test' };
		const { op } = await signCatalogOp(key, 'add', 'net1', { lishID: '123', name: 'Test' }, clock);
		expect(op.payload.type).toBe('add');
		expect(op.payload.networkID).toBe('net1');
		expect(op.keyType).toBe('Ed25519');
		const valid = await verifyCatalogOp(op);
		expect(valid).toBe(true);
	});

	test('tampered payload fails verification', async () => {
		const key = await generateKeyPair('Ed25519');
		const clock: HLC = { wallTime: Date.now(), logical: 0, nodeID: 'test' };
		const { op } = await signCatalogOp(key, 'add', 'net1', { lishID: '123' }, clock);
		op.payload.data = { lishID: 'TAMPERED' };
		const valid = await verifyCatalogOp(op);
		expect(valid).toBe(false);
	});

	test('wrong key fails verification', async () => {
		const key1 = await generateKeyPair('Ed25519');
		const key2 = await generateKeyPair('Ed25519');
		const clock: HLC = { wallTime: Date.now(), logical: 0, nodeID: 'test' };
		const { op } = await signCatalogOp(key1, 'add', 'net1', { lishID: '123' }, clock);
		const fakeOp: SignedCatalogOp = { ...op, signer: key2.publicKey.toString() };
		const valid = await verifyCatalogOp(fakeOp);
		expect(valid).toBe(false);
	});

	test('updatedClock is > input clock', async () => {
		const key = await generateKeyPair('Ed25519');
		const clock: HLC = { wallTime: Date.now(), logical: 0, nodeID: 'test' };
		const { updatedClock } = await signCatalogOp(key, 'add', 'net1', {}, clock);
		const isGreater = updatedClock.wallTime > clock.wallTime ||
			(updatedClock.wallTime === clock.wallTime && updatedClock.logical > clock.logical);
		expect(isGreater).toBe(true);
	});

	test('networkID is embedded in signed payload', async () => {
		const key = await generateKeyPair('Ed25519');
		const clock: HLC = { wallTime: Date.now(), logical: 0, nodeID: 'test' };
		const { op } = await signCatalogOp(key, 'add', 'mynet', {}, clock);
		expect(op.payload.networkID).toBe('mynet');
	});

	test('nonce is unique per operation', async () => {
		const key = await generateKeyPair('Ed25519');
		const clock: HLC = { wallTime: Date.now(), logical: 0, nodeID: 'test' };
		const { op: op1, updatedClock } = await signCatalogOp(key, 'add', 'net1', {}, clock);
		const { op: op2 } = await signCatalogOp(key, 'add', 'net1', {}, updatedClock);
		expect(op1.payload.nonce).not.toBe(op2.payload.nonce);
	});

	test('different operation types are all signable', async () => {
		const key = await generateKeyPair('Ed25519');
		let clock: HLC = { wallTime: Date.now(), logical: 0, nodeID: 'test' };
		for (const type of ['add', 'update', 'remove', 'acl_grant', 'acl_revoke'] as const) {
			const { op, updatedClock } = await signCatalogOp(key, type, 'net1', {}, clock);
			clock = updatedClock;
			expect(await verifyCatalogOp(op)).toBe(true);
			expect(op.payload.type).toBe(type);
		}
	});
});
