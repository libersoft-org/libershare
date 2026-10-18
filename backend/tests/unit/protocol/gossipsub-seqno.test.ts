import { expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { StrictSign } from '@libp2p/gossipsub';

/**
 * The public node and every protected lishnet's node run in one process. Gossipsub numbered the messages of all of
 * them from one counter, so a peer that saw both lishnets read consecutive seqnos on two identities and knew they
 * were the same machine (patches/@libp2p%2Fgossipsub@17.1.2.patch).
 */
const utils = join(dirname(Bun.resolveSync('@libp2p/gossipsub', import.meta.dir)), 'utils');
const { buildRawMessage } = await import(join(utils, 'buildRawMessage.js'));
const { getPublishConfigFromPeerId } = await import(join(utils, 'publishConfig.js'));

async function author(): Promise<unknown> {
	const key = await generateKeyPair('Ed25519');
	return getPublishConfigFromPeerId(StrictSign, peerIdFromPrivateKey(key), key);
}

async function seqno(config: unknown): Promise<bigint> {
	const data = new TextEncoder().encode('x');
	const { raw } = await buildRawMessage(config, 'topic', data, data);
	return new DataView(raw.seqno.buffer, raw.seqno.byteOffset, 8).getBigUint64(0, false);
}

test('two nodes in one process number their messages independently', async () => {
	const publicNode = await author();
	const protectedNode = await author();
	const first = await seqno(publicNode);
	const other = await seqno(protectedNode);
	const second = await seqno(publicNode);
	// Each author counts on by one, whatever the other sent in between.
	expect(second).toBe(first + 1n);
	// And the two counters start far apart: no "next number" from one identity on the other.
	const gap = other > first ? other - first : first - other;
	expect(gap).toBeGreaterThan(1000n);
});

test('a counter starts within 2^40 ns after the clock', async () => {
	const before = BigInt(Date.now()) * 1000000n;
	const value = await seqno(await author());
	expect(value).toBeGreaterThan(before);
	expect(value).toBeLessThanOrEqual(BigInt(Date.now()) * 1000000n + (1n << 40n) + 1n);
});
