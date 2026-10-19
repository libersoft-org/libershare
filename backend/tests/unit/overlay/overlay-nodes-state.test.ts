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
			// The two swap addresses: the same set, but each name's last address changed.
			answers.set('lighthouse.example.test', '198.51.100.6');
			answers.set('relay.example.test', '198.51.100.1');
			await (h.nodes as any).followInfraAddresses(NET);
			// Then the lighthouse's name fails and the relay moves on: the lighthouse keeps .6, its own last address.
			answers.set('lighthouse.example.test', null);
			answers.set('relay.example.test', '198.51.100.7');
			await (h.nodes as any).followInfraAddresses(NET);
			expect(await allowed()).toEqual(['198.51.100.6/32', '198.51.100.7/32']);
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

	// A device holding the CA key, restored from an older backup, signed a newer state without a recent revocation:
	// every member took it and let the revoked certificate back in.
	it('keeps an accepted revocation when a newer state lacks it', async () => {
		const h = await harness();
		try {
			await h.nodes.acceptState(NET, await h.sign(5, [FP]));
			await h.nodes.acceptState(NET, await h.sign(6, []));
			expect((await h.nodes.currentState(NET, h.overlay()))?.version).toBe(6);
			expect((await h.store.readJSON<any>('nebula.yml'))?.pki.blocklist).toEqual([FP]);
		} finally {
			await h.cleanup();
		}
	});

	// The node kept the revocation for itself but passed on only the newer state without it: a node catching up from it
	// never learned of the revocation and let the revoked member in.
	it('passes on the signed revocation a newer state lacks, so a node catching up from it blocks it too', async () => {
		const a = await harness();
		const b = await harness();
		try {
			const revoking = await a.sign(5, [FP]);
			await a.nodes.acceptState(NET, revoking);
			await a.nodes.acceptState(NET, await a.sign(6, []));
			a.broadcasts.length = 0;
			await a.nodes.publishState(NET, true);
			expect(a.broadcasts.map(m => JSON.parse(m.message.signed.state).version)).toEqual([6, 5]);
			// B has the same CA: it takes exactly what A sends.
			(b.nodes as any).caKeys = (a.nodes as any).caKeys;
			for (const m of a.broadcasts) await b.nodes.acceptState(NET, m.message.signed);
			expect((await b.nodes.currentState(NET, b.overlay()))?.version).toBe(6);
			expect((await b.nodes.knownRevocations(NET, b.overlay())).fingerprints).toEqual([FP]);
			expect((await b.store.readJSON<any>('nebula.yml'))?.pki.blocklist).toEqual([FP]);
			// A newer state that carries the revocation again makes the proof unnecessary.
			await a.nodes.acceptState(NET, await a.sign(7, [FP]));
			a.broadcasts.length = 0;
			await a.nodes.publishState(NET, true);
			expect(a.broadcasts.map(m => JSON.parse(m.message.signed.state).version)).toEqual([7]);
		} finally {
			await a.cleanup();
			await b.cleanup();
		}
	});

	// A revocation that came late, in an older state, waited a minute for the periodic sweep of the open tunnels.
	it('checks the open tunnels at once when an older state brings a revocation', async () => {
		const h = await harness();
		const swept: string[] = [];
		(h.nodes as any).reconfigure = async () => {};
		(h.nodes as any).sweepRevokedPeers = async (id: string) => void swept.push(id);
		try {
			await h.nodes.acceptState(NET, await h.sign(6, []));
			swept.length = 0;
			expect(await h.nodes.acceptState(NET, await h.sign(5, [FP]))).toBe(false);
			expect(swept).toEqual([NET]);
		} finally {
			await h.cleanup();
		}
	});

	/** A tunnel to one member: its certificate's name, fingerprint and start, as the helper reports them. */
	function tunnel(h: Awaited<ReturnType<typeof harness>>, host: { name: string; fingerprint: string; notBefore: string }) {
		let reloads = 0;
		(h.nodes as any).running.get(NET).helper = {
			isRunning: () => true,
			reload: async () => void reloads++,
			status: async () => ({ hosts: [{ vpnAddrs: ['100.64.0.7'], relayedVia: [], ...host }], inboundPort: 0 }),
		};
		return { reloads: () => reloads };
	}

	const MEMBER = '12D3KooWGzBgW1mHp7DpLbR2X5yfDN8dRtVYWNw2wXxu3yi1fYM5';
	const revokeMember = (h: Awaited<ReturnType<typeof harness>>, version: number) => signState({ networkID: NET, version, lighthouses: [], relays: [], revoked: [], revokedPeers: { [MEMBER]: '2026-10-19T10:00:00.000Z' } }, h.caKey);

	// The member's certificate there came from another device holding the CA key: no state listed its fingerprint.
	it('refuses a revoked member on a certificate issued before the revocation, and blocks that certificate', async () => {
		const h = await harness();
		const older = 'c'.repeat(64);
		const t = tunnel(h, { name: MEMBER, fingerprint: older, notBefore: '2026-10-18T09:00:00Z' });
		try {
			await h.nodes.acceptState(NET, await revokeMember(h, 5));
			expect(await h.nodes.authorizePeer(NET, MEMBER, '100.64.0.7')).toBe(false);
			expect((await h.store.readJSON<any>('nebula.yml'))?.pki.blocklist).toEqual([older]);
			expect(t.reloads()).toBeGreaterThan(0);
		} finally {
			await h.cleanup();
		}
	});

	// A later approval limited the member's older certificates; one of them kept the member in past that end.
	it('lets a member in on an older certificate until a signed limit ends it, then blocks it', async () => {
		const h = await harness();
		const older = 'e'.repeat(64);
		tunnel(h, { name: MEMBER, fingerprint: older, notBefore: '2026-01-01T00:00:00Z' });
		try {
			await h.nodes.acceptState(NET, await signState({ networkID: NET, version: 5, lighthouses: [], relays: [], revoked: [], limits: { [MEMBER]: [['2026-06-01T00:00:00Z', new Date(Date.now() + 86_400_000).toISOString()]] } }, h.caKey));
			expect(await h.nodes.authorizePeer(NET, MEMBER, '100.64.0.7')).toBe(true);
			// The same limit, once its end has passed: refused, and the certificate blocked.
			const h2 = await harness();
			const t2 = tunnel(h2, { name: MEMBER, fingerprint: older, notBefore: '2026-01-01T00:00:00Z' });
			try {
				await h2.nodes.acceptState(NET, await signState({ networkID: NET, version: 5, lighthouses: [], relays: [], revoked: [], limits: { [MEMBER]: [['2026-06-01T00:00:00Z', new Date(Date.now() - 1000).toISOString()]] } }, h2.caKey));
				expect(await h2.nodes.authorizePeer(NET, MEMBER, '100.64.0.7')).toBe(false);
				await h2.nodes.sweepRevokedPeers(NET);
				expect((await h2.store.readJSON<any>('nebula.yml'))?.pki.blocklist).toEqual([older]);
				expect(t2.reloads()).toBeGreaterThan(0);
			} finally {
				await h2.cleanup();
			}
		} finally {
			await h.cleanup();
		}
	});

	it('lets the member in again on a certificate issued after the revocation', async () => {
		const h = await harness();
		tunnel(h, { name: MEMBER, fingerprint: 'd'.repeat(64), notBefore: '2026-10-19T10:00:01Z' });
		try {
			await h.nodes.acceptState(NET, await revokeMember(h, 5));
			expect(await h.nodes.authorizePeer(NET, MEMBER, '100.64.0.7')).toBe(true);
		} finally {
			await h.cleanup();
		}
	});

	// The libp2p handshake proves a key, not a membership: a member spoke under another member's peer ID.
	it('refuses a peer ID other than the one the tunnel certificate names, and a peer with no tunnel', async () => {
		const h = await harness();
		tunnel(h, { name: MEMBER, fingerprint: 'd'.repeat(64), notBefore: '2026-10-18T09:00:00Z' });
		try {
			expect(await h.nodes.authorizePeer(NET, MEMBER, '100.64.0.7')).toBe(true);
			expect(await h.nodes.authorizePeer(NET, '12D3KooWQ4bYeqtXdNbcrfoFjQY8AsZqmSrRmgxWRDK4QMg8Vhm2', '100.64.0.7')).toBe(false);
			expect(await h.nodes.authorizePeer(NET, MEMBER, '100.64.0.8')).toBe(false);
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
