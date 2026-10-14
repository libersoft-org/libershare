import { describe, it, expect } from 'bun:test';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { buildLibp2pConfig } from '../../../src/protocol/network-config.ts';

/**
 * A missed heartbeat ping must not tear a connection down. Under a bulk transfer the ping
 * stream waits behind chunk data, and libp2p's default reaction aborted the whole
 * connection — every chunk stream on it — every few seconds.
 */
describe('buildLibp2pConfig — connection monitor', () => {
	it('keeps measuring latency but never aborts a connection over a failed ping', async () => {
		const privateKey = await generateKeyPair('Ed25519');
		const { config } = buildLibp2pConfig({ privateKey, datastore: {}, allSettings: { network: { mdnsEnabled: false } } as any, bootstrapPeers: [], myPeerID: 'self' });

		expect(config.connectionMonitor?.enabled).not.toBe(false);
		expect(config.connectionMonitor?.abortConnectionOnPingFailure).toBe(false);
	});
});
