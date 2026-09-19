import { describe, expect, it } from 'bun:test';
import { encode as lpEncode } from 'it-length-prefixed';
import { encode as codecEncode } from '../../../src/protocol/codec.ts';
import { initLISHnetsHandlers } from '../../../src/api/lishnets.ts';
import { LISHMutationGate } from '../../../src/api/lishs.ts';
import type { IStoredLISH } from '@shared';

/**
 * Adding another peer's LISH runs the real handler here, over a manifest response held
 * open, with a factory reset closing the mutation gate in the middle.
 *
 * The operation takes its permit at the public entry and only then dials and downloads the
 * manifest — the part that can take a while. An accepted operation has to finish that and
 * store the result; the reset waits for it, which is what the drain is for. Before the fix
 * the import step asked the closed gate for a second permit and refused its own second half.
 */

const MANIFEST: IStoredLISH = {
	id: 'lish-add-peer-test',
	created: new Date().toISOString(),
	chunkSize: 1024,
	checksumAlgo: 'sha256',
	files: [{ path: 'a.bin', size: 1024, checksums: ['h1'] }],
};

/** A manifest response that only arrives once the returned `deliver` is called. */
function heldStream(): { stream: any; deliver: () => void } {
	let release!: () => void;
	const held = new Promise<void>(resolve => {
		release = resolve;
	});
	async function* source() {
		await held;
		yield lpEncode.single(codecEncode({ manifest: MANIFEST })).subarray();
	}
	return {
		stream: { status: 'open', send() {}, close: async () => {}, [Symbol.asyncIterator]: source },
		deliver: () => release(),
	};
}

function makeHandlers(gate: LISHMutationGate, importManifest: (...args: any[]) => Promise<any>, stream: any): ReturnType<typeof initLISHnetsHandlers> {
	const networks = {
		getRunningNetwork: () => ({
			dialProtocolByPeerId: async () => ({ stream }),
		}),
	} as never;
	const settings = { get: () => undefined } as never;
	// Mirrors `runMutation` in the lishs handlers: a synchronous permit, refused once closed.
	const runLISHMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
		const leave = gate.tryEnter();
		if (!leave) throw new Error('LISH changes are paused during factory reset');
		try {
			return await operation();
		} finally {
			leave();
		}
	};
	return initLISHnetsHandlers(networks, {} as never, () => {}, settings, importManifest as never, runLISHMutation);
}

describe('adding a peer LISH while a factory reset closes the gate', () => {
	it('finishes the accepted operation and lets the reset drain afterwards', async () => {
		const gate = new LISHMutationGate();
		const held = heldStream();
		const imported: string[] = [];
		const importManifest = async (lish: IStoredLISH): Promise<{ lishID: string }> => {
			// Runs after the gate closed: an entry point that took the gate again would never
			// reach this line.
			expect(gate.isClosed).toBe(true);
			imported.push(lish.id);
			return { lishID: lish.id };
		};

		const handlers = makeHandlers(gate, importManifest, held.stream);
		const adding = handlers.addPeerLish({ lishID: MANIFEST.id, peerID: 'peer-1', networkID: 'net-1' });
		await Promise.resolve();

		// The reset arrives while the manifest is still on its way.
		let drained = false;
		const draining = gate.closeAndDrain().then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);

		held.deliver();
		await expect(adding).resolves.toEqual({ lishID: MANIFEST.id });
		await draining;
		expect(imported).toEqual([MANIFEST.id]);
		expect(drained).toBe(true);
	});

	it('refuses a peer LISH that arrives after the gate is already closed', async () => {
		const gate = new LISHMutationGate();
		await gate.closeAndDrain();
		const held = heldStream();
		held.deliver();
		const handlers = makeHandlers(gate, async () => ({ lishID: MANIFEST.id }), held.stream);

		await expect(handlers.addPeerLish({ lishID: MANIFEST.id, peerID: 'peer-1', networkID: 'net-1' })).rejects.toThrow('paused during factory reset');
	});
});
