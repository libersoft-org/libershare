import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { DEFAULT_MAX_RELAY_RESERVATIONS } from '@shared';
import { buildLibp2pConfig } from '../../../src/protocol/network-config.ts';
import { Settings } from '../../../src/settings.ts';

/**
 * Serving relay for other peers is opt-in, and its reservation limit is finite unless the
 * operator explicitly stored 0. A malformed stored limit — from an old file or an import —
 * must never become an unlimited relay.
 */

const logs: string[] = [];
spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
	logs.push(args.join(' '));
});
afterEach(() => {
	logs.length = 0;
});

function build(network: Record<string, unknown>): any {
	return buildLibp2pConfig({
		privateKey: { publicKey: { toString: (): string => 'self' } } as any,
		datastore: {} as any,
		allSettings: { network: { incomingPort: 0, peerExchange: { enabled: false }, ...network } } as any,
		bootstrapPeers: [],
		myPeerID: 'self',
	}).config;
}

const relayLog = (): string | undefined => logs.find(line => line.includes('Circuit relay server enabled'));

describe('relay server defaults', () => {
	it('is off for new installations with a finite reservation limit', () => {
		// getDefaults reads only the built-in defaults, never an instance's saved state.
		const network = Settings.prototype.getDefaults.call(null).network;
		expect(network.allowRelay).toBe(false);
		expect(network.maxRelayReservations).toBe(DEFAULT_MAX_RELAY_RESERVATIONS);
		expect(DEFAULT_MAX_RELAY_RESERVATIONS).toBe(200);
	});

	it('runs only for an explicit true', () => {
		for (const allowRelay of [undefined, false, 'true', 1]) expect(build({ allowRelay }).services.relay).toBeUndefined();
		expect(build({ allowRelay: true, maxRelayReservations: 10 }).services.relay).toBeDefined();
	});

	it('keeps an explicit limit and an explicit 0 as unlimited', () => {
		build({ allowRelay: true, maxRelayReservations: 10 });
		expect(relayLog()).toContain('maxReservations: 10,');
		logs.length = 0;
		build({ allowRelay: true, maxRelayReservations: 0 });
		expect(relayLog()).toContain('maxReservations: unlimited');
	});

	it('falls back to the finite default for a missing or malformed limit', () => {
		for (const maxRelayReservations of [undefined, -1, 1.5, '0', '50', Number.NaN, Number.POSITIVE_INFINITY, null]) {
			logs.length = 0;
			build({ allowRelay: true, maxRelayReservations });
			expect(relayLog()).toContain(`maxReservations: ${DEFAULT_MAX_RELAY_RESERVATIONS},`);
		}
	});
});
