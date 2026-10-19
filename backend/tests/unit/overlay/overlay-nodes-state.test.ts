import { describe, expect, it, spyOn } from 'bun:test';
import * as dns from 'node:dns/promises';
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
		unapplied: false,
		infraIPs: [],
		infraByHost: new Map(),
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

	// Stored before it was applied: a reload that failed once left the revocation out of Nebula for good.
	it('applies a stored state again when the reload failed, on the next copy of it', async () => {
		const h = await harness();
		let reloads = 0;
		(h.nodes as any).running.get(NET).helper = {
			isRunning: () => true,
			reload: async () => {
				if (++reloads === 1) throw new Error('overlay helper /reload: HTTP 500');
			},
		};
		try {
			await expect(h.nodes.acceptState(NET, await h.sign(5))).rejects.toThrow('HTTP 500');
			expect(await h.nodes.acceptState(NET, await h.sign(5))).toBe(false);
			expect(reloads).toBe(2);
			expect(await h.nodes.acceptState(NET, await h.sign(5))).toBe(false);
			expect(reloads).toBe(2);
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

	// The allow list names addresses: a lighthouse given by name that moved was never let in again.
	it('follows a new address of a host given by name, and keeps the old one while the name does not resolve', async () => {
		const h = await harness();
		let answer: string | null = '198.51.100.1';
		const lookup = spyOn(dns, 'lookup').mockImplementation((async () => {
			if (!answer) throw new Error('ENOTFOUND');
			return [{ address: answer, family: 4 }];
		}) as any);
		const allowed = async (): Promise<string[]> => Object.keys((await h.store.readJSON<any>('nebula.yml'))?.lighthouse.remote_allow_list ?? {}).filter(k => k.endsWith('/32'));
		try {
			await h.nodes.acceptState(NET, await signState({ networkID: NET, version: 5, lighthouses: [{ vpnIP: '100.64.0.1', addr: 'lighthouse.example.test:4242' }], relays: [], revoked: [] }, h.caKey));
			expect(await allowed()).toEqual(['198.51.100.1/32']);
			answer = '198.51.100.2';
			await (h.nodes as any).followInfraAddresses(NET);
			expect(await allowed()).toEqual(['198.51.100.2/32']);
			answer = null;
			await (h.nodes as any).followInfraAddresses(NET);
			expect(await allowed()).toEqual(['198.51.100.2/32']);
		} finally {
			lookup.mockRestore();
			await h.cleanup();
		}
	});

	// One name that stopped resolving held back the whole list, so another host's new address stayed locked out.
	it("follows one host's new address while another host's name does not resolve", async () => {
		const h = await harness();
		const answers = new Map<string, string | null>([
			['lighthouse.example.test', '198.51.100.1'],
			['relay.example.test', '198.51.100.5'],
		]);
		const lookup = spyOn(dns, 'lookup').mockImplementation((async (host: string) => {
			const answer = answers.get(host);
			if (!answer) throw new Error('ENOTFOUND');
			return [{ address: answer, family: 4 }];
		}) as any);
		const allowed = async (): Promise<string[]> => Object.keys((await h.store.readJSON<any>('nebula.yml'))?.lighthouse.remote_allow_list ?? {}).filter(k => k.endsWith('/32'));
		try {
			await h.nodes.acceptState(NET, await signState({ networkID: NET, version: 5, lighthouses: [{ vpnIP: '100.64.0.1', addr: 'lighthouse.example.test:4242' }], relays: [{ vpnIP: '100.64.0.5', addr: 'relay.example.test:4242' }], revoked: [] }, h.caKey));
			expect(await allowed()).toEqual(['198.51.100.1/32', '198.51.100.5/32']);
			answers.set('lighthouse.example.test', null);
			answers.set('relay.example.test', '198.51.100.6');
			await (h.nodes as any).followInfraAddresses(NET);
			expect(await allowed()).toEqual(['198.51.100.1/32', '198.51.100.6/32']);
		} finally {
			lookup.mockRestore();
			await h.cleanup();
		}
	});

	// A lishnet deleted and added again in one run lost ca.crt, and the cached key never wrote it back: signing and
	// importing certificates failed with OVERLAY_CERTIFICATE_INVALID.
	it('writes the CA certificate back even when its key is cached', async () => {
		const h = await harness();
		try {
			await h.store.remove('ca.crt');
			await h.nodes.caPublicKey(h.store, 'test-ca');
			expect(await h.store.readText('ca.crt')).toBe('test-ca');
		} finally {
			await h.cleanup();
		}
	});

	// A founder restored on a clean device has its backup's revocations but no signed state yet: Nebula ran without them.
	it("blocks the member list's revocations before any signed state arrives", async () => {
		const h = await harness();
		try {
			await h.store.writeJSON('founder.json', { nextHost: 3, members: [{ name: 'gone', peerID: 'p', vpnIP: '100.64.0.9', roles: [], notAfter: '2099-01-01T00:00:00Z', fingerprint: 'd'.repeat(64), issued: '', revoked: true }], requests: [], revoked: ['e'.repeat(64)] });
			await h.nodes.reconfigure(NET);
			expect(((await h.store.readJSON<any>('nebula.yml'))?.pki.blocklist ?? []).sort()).toEqual(['d'.repeat(64), 'e'.repeat(64)]);
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
