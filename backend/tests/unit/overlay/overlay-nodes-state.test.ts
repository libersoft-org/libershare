import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { type LISHNetworkConfig, type LISHOverlayDefinition, type OverlayState } from '@shared';
import { OverlayNodes } from '../../../src/overlay/overlay-nodes.ts';
import { OverlayStore } from '../../../src/overlay/overlay-store.ts';
import { signState } from '../../../src/overlay/overlay-state.ts';

const NET = 'net-1';
const FP = 'ab'.repeat(32);

/**
 * A running protected lishnet without Nebula or libp2p: the node records what it broadcasts, the helper is down.
 * The CA public key is put in the cache the helper would otherwise fill.
 */
async function harness() {
	const dataDir = await mkdtemp(join(tmpdir(), 'overlay-nodes-'));
	const key = await generateKeyPair('Ed25519');
	const caKey = `-----BEGIN NEBULA ED25519 PRIVATE KEY-----\n${Buffer.from(key.raw).toString('base64')}\n-----END NEBULA ED25519 PRIVATE KEY-----\n`;
	let overlay: LISHOverlayDefinition = { type: 'nebula', caCert: 'test-ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 };
	const broadcasts: any[] = [];
	const changes: OverlayState[] = [];
	const nodes = new OverlayNodes({
		dataDir,
		dataServer: {} as any,
		settings: {} as any,
		getRow: (): LISHNetworkConfig => ({ networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay }),
		saveOverlay: (_id, next) => {
			overlay = next;
		},
		onPeerCountChange: () => {},
		onBootstrapStatusChange: () => {},
		onStateChange: (_id, state) => changes.push(state),
	});
	(nodes as any).caKeys.set('test-ca', Buffer.from(key.publicKey.raw).toString('hex'));
	const store = new OverlayStore(dataDir, NET);
	await store.ensureDir();
	(nodes as any).running.set(NET, {
		networkID: NET,
		store,
		vpnIP: '100.64.0.2',
		peerID: '12D3KooWGzBgW1mHp7DpLbR2X5yfDN8dRtVYWNw2wXxu3yi1fYM5',
		helper: { isRunning: () => false },
		network: { broadcast: async (topic: string, message: any) => broadcasts.push({ topic, message }), addBootstrapPeers: async () => 'completed' },
		// A peer subscribed a moment ago, so the rate limit of peer-triggered sends is armed.
		lastPublish: Date.now(),
		startOnly: 'false|0',
	});
	const sign = (version: number, revoked: string[] = [FP]) => signState({ networkID: NET, version, lighthouses: [{ vpnIP: '100.64.0.1', addr: '203.0.113.7:4242' }], relays: [], revoked }, caKey);
	return { nodes, store, broadcasts, changes, sign, caKey, overlay: () => overlay, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

describe('OverlayNodes network state', () => {
	it('passes a newer state on at once, even right after a rate-limited send', async () => {
		const h = await harness();
		try {
			expect(await h.nodes.acceptState(NET, await h.sign(5))).toBe(true);
			await Bun.sleep(10);
			expect(h.broadcasts).toHaveLength(1);
			expect(h.broadcasts[0].topic).toBe(`lish-overlay-state/${NET}`);
			expect(h.broadcasts[0].message.type).toBe('overlayState');
			expect(h.changes.map(c => c.version)).toEqual([5]);
			expect(h.overlay()).toMatchObject({ version: 5, lighthouses: [{ vpnIP: '100.64.0.1', addr: '203.0.113.7:4242' }] });
			// The revocation reached the generated Nebula configuration.
			expect((await h.store.readJSON<any>('nebula.yml'))?.pki.blocklist).toEqual([FP]);
		} finally {
			await h.cleanup();
		}
	});

	it('keeps the newer state and does not re-announce for an older one inside the rate limit', async () => {
		const h = await harness();
		try {
			await h.nodes.acceptState(NET, await h.sign(5));
			await Bun.sleep(10);
			expect(await h.nodes.acceptState(NET, await h.sign(3, []))).toBe(false);
			await Bun.sleep(10);
			expect(h.broadcasts).toHaveLength(1);
			expect((await h.nodes.currentState(NET, h.overlay()))?.version).toBe(5);
		} finally {
			await h.cleanup();
		}
	});

	// The revoked member hears of its revocation only through this message; blocked at once, it sometimes never did.
	it('passes a new revocation on a while before blocking it, an unchanged list without delay', async () => {
		const h = await harness();
		const reconfigured: number[] = [];
		(h.nodes as any).reconfigure = async () => {
			reconfigured.push(Date.now());
		};
		const sent = (): number => h.broadcasts[h.broadcasts.length - 1].at;
		h.broadcasts.push = function (this: any[], b: any) {
			return Array.prototype.push.call(this, { ...b, at: Date.now() });
		};
		try {
			await h.nodes.acceptState(NET, await h.sign(5));
			expect(h.broadcasts).toHaveLength(1);
			expect(reconfigured[0]! - sent()).toBeGreaterThanOrEqual(900);
			await h.nodes.acceptState(NET, await h.sign(6));
			expect(h.broadcasts).toHaveLength(2);
			expect(reconfigured[1]! - sent()).toBeLessThan(500);
		} finally {
			await h.cleanup();
		}
	});

	// Nebula takes the lighthouse role and the listen port at start only: a reload left a new host listening nowhere.
	it('restarts the node when it becomes a lighthouse', async () => {
		const h = await harness();
		const calls: string[] = [];
		(h.nodes as any).leave = async () => calls.push('leave');
		(h.nodes as any).join = async () => calls.push('join');
		try {
			const signed = await signState({ networkID: NET, version: 5, lighthouses: [{ vpnIP: '100.64.0.2', addr: '203.0.113.8:4243' }], relays: [], revoked: [] }, h.caKey);
			await h.nodes.acceptState(NET, signed);
			expect(calls).toEqual(['leave', 'join']);
		} finally {
			await h.cleanup();
		}
	});

	it('refuses a state signed by another key', async () => {
		const h = await harness();
		try {
			const other = await generateKeyPair('Ed25519');
			const forged = await signState({ networkID: NET, version: 9, lighthouses: [], relays: [], revoked: [] }, `-----BEGIN NEBULA ED25519 PRIVATE KEY-----\n${Buffer.from(other.raw).toString('base64')}\n-----END NEBULA ED25519 PRIVATE KEY-----\n`);
			await expect(h.nodes.acceptState(NET, forged)).rejects.toThrow('not signed by');
			expect(h.broadcasts).toHaveLength(0);
		} finally {
			await h.cleanup();
		}
	});
});
