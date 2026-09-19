import { describe, it, expect } from 'bun:test';
import { initIdentityHandlers } from '../../../src/api/identity.ts';
import { NetworkMutationGate, type Networks } from '../../../src/lishnet/lishnets.ts';

/**
 * Identity writes restart every network around a key write. Two of them, or one of them
 * and a factory reset, must not interleave their stops and starts.
 *
 * The real {@link NetworkMutationGate} is used rather than a stub lease: the guarantee
 * under test is that these handlers queue on the SAME gate the factory reset takes, which
 * a stub that always grants immediately cannot show.
 */

/** A libp2p private key protobuf for a real Ed25519 key, base64 — the handler decodes it. */
const KEY = 'CAESQNs1s0lYRIvIzKjEJ3T0XEZ1TaL1U0bVuaGfDJtzFfnXV7mfNBLSK0bBsJ1uZE3BhmVBXwS5OW1L4gAzxdPKAAA=';

interface Harness {
	handlers: ReturnType<typeof initIdentityHandlers>;
	log: string[];
	/** Releases the key write that is currently parked, if any. */
	release: () => void;
}

function makeHarness(): Harness {
	const log: string[] = [];
	const gate = new NetworkMutationGate();
	let parked: (() => void) | null = null;

	const network = {
		// Park mid-sequence: the interleaving this guards against can only form while one
		// call sits between its stop and its start.
		writeIdentityKey: async (): Promise<void> => {
			log.push('write');
			await new Promise<void>(resolve => {
				parked = resolve;
			});
		},
		clearIdentityKey: async (): Promise<void> => {
			log.push('clear');
			await new Promise<void>(resolve => {
				parked = resolve;
			});
		},
		exportIdentity: () => null,
	};

	const networks = {
		getNetwork: () => network,
		beginMaintenance: () => gate.beginMaintenance(),
		prepareMaintenance: () => gate.prepareMaintenance(),
		stopAllNetworks: async (): Promise<void> => {
			log.push('stop');
		},
		startEnabledNetworks: async (): Promise<void> => {
			log.push('start');
		},
	} as unknown as Networks;

	return {
		handlers: initIdentityHandlers(networks),
		log,
		release: () => {
			const resume = parked;
			parked = null;
			resume?.();
		},
	};
}

/** Let every already-queued microtask run, so a handler that is free to proceed does. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('identity writes take the network maintenance lease', () => {
	it('keeps two concurrent imports from interleaving their restarts', async () => {
		const h = makeHarness();

		const first = h.handlers.applyImported({ privateKey: KEY });
		await settle();
		expect(h.log).toEqual(['stop', 'write']);

		// Arrives while the first one is parked between its stop and its start.
		const second = h.handlers.applyImported({ privateKey: KEY });
		await settle();
		// Without the lease the second call stops the networks again here, on a node the
		// first one is about to start, and both starts then run against one stop.
		expect(h.log).toEqual(['stop', 'write']);

		h.release();
		await first;
		await settle();
		expect(h.log).toEqual(['stop', 'write', 'start', 'stop', 'write']);

		h.release();
		await second;
		expect(h.log).toEqual(['stop', 'write', 'start', 'stop', 'write', 'start']);
	});

	it('makes a regenerate wait for an import already under way', async () => {
		const h = makeHarness();

		const imported = h.handlers.applyImported({ privateKey: KEY });
		await settle();
		const regenerated = h.handlers.regenerate();
		await settle();
		expect(h.log).toEqual(['stop', 'write']);

		h.release();
		await imported;
		await settle();
		expect(h.log).toEqual(['stop', 'write', 'start', 'stop', 'clear']);

		h.release();
		await regenerated;
		expect(h.log).toEqual(['stop', 'write', 'start', 'stop', 'clear', 'start']);
	});

	it('releases the lease when the key write fails, so the next one still runs', async () => {
		const log: string[] = [];
		const gate = new NetworkMutationGate();
		const network = {
			writeIdentityKey: async (): Promise<void> => {
				log.push('write');
				throw new Error('disk full');
			},
			clearIdentityKey: async (): Promise<void> => {
				log.push('clear');
			},
			exportIdentity: () => null,
		};
		const networks = {
			getNetwork: () => network,
			beginMaintenance: () => gate.beginMaintenance(),
			prepareMaintenance: () => gate.prepareMaintenance(),
			stopAllNetworks: async (): Promise<void> => {
				log.push('stop');
			},
			startEnabledNetworks: async (): Promise<void> => {
				log.push('start');
			},
		} as unknown as Networks;
		const handlers = initIdentityHandlers(networks);

		await expect(handlers.applyImported({ privateKey: KEY })).rejects.toThrow('disk full');
		// The failed import restarts on the old key; a lease left held would hang this.
		await handlers.regenerate();
		expect(log).toEqual(['stop', 'write', 'start', 'stop', 'clear', 'start']);
	});
});
