import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { decodeInvite, encodeInvite, type OverlayInvite } from '@shared';
import { OverlayAccess } from '../../../src/overlay/overlay-access.ts';
import { signAnswer, verifyAnswer } from '../../../src/overlay/overlay-state.ts';
import { OverlayStore } from '../../../src/overlay/overlay-store.ts';

const NET = 'net-invite';
const INVITE = '0b6f6a3e-5d1c-4f0e-9a39-2a1e5c3f7d10';
const GUEST_IP = '100.64.255.17';
const b58 = (c: string): string => c.repeat(46);
const request = (peerID: string) => ({ type: 'lish-overlay-request', networkID: NET, name: 'Invited', peerID, publicKey: '-----BEGIN NEBULA X25519 PUBLIC KEY-----\nx\n-----END NEBULA X25519 PUBLIC KEY-----', created: '2026-01-01T00:00:00Z' });

/** The founder's side of an invite: one node's request goes into the queue once, and its certificate back once issued. */
describe('invite exchange — founder', () => {
	let dir: string;
	let access: OverlayAccess;
	let store: OverlayStore;
	const events: string[] = [];
	const answer = (ip: string, message: unknown): Promise<any> => (access as any).answerInvite(NET, INVITE, ip, message);

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'overlay-invite-'));
		events.length = 0;
		access = new OverlayAccess({
			nodes: { network: () => undefined, store: (id: string) => new OverlayStore(dir, id), ownCertificate: async () => null, currentState: async () => null, knownRevocations: async () => ({ fingerprints: [], peers: {} }), publishNewState: async () => {} } as any,
			getRow: () => ({ networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } }),
			addNetwork: async () => {},
			listOverlayIDs: () => [],
			refresh: async () => {},
			emit: event => void events.push(event),
		});
		store = new OverlayStore(dir, NET);
		await store.ensureDir();
		await store.writeText('ca.key', 'key');
		await store.writeJSON('founder.json', { nextHost: 2, lane: 0, members: [], requests: [], invites: [{ id: INVITE, vpnIP: GUEST_IP, expires: new Date(Date.now() + 86_400_000).toISOString() }] });
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('queues the request once and answers pending until it is approved', async () => {
		expect(await answer(GUEST_IP, { invite: INVITE, request: request(b58('A')) })).toEqual({ status: 'pending' });
		expect(await answer(GUEST_IP, { invite: INVITE, request: request(b58('A')) })).toEqual({ status: 'pending' });
		const queued = (await store.readFounder()).requests;
		expect(queued).toHaveLength(1);
		expect(queued[0]!.invite).toBe(INVITE);
		expect(events).toEqual(['overlay:request']);
	});

	it('hands out the certificate issued on the request', async () => {
		await answer(GUEST_IP, { invite: INVITE, request: request(b58('A')) });
		const issue = spyOn(OverlayAccess.prototype as any, 'issueCertificate').mockImplementation(async () => ({ cert: 'crt', fingerprint: 'f'.repeat(64), notAfter: '2099-01-01T00:00:00Z' }));
		try {
			const pending = (await store.readFounder()).requests[0]!;
			const bundle = await access.approve(NET, pending.id);
			expect(await answer(GUEST_IP, { invite: INVITE, request: request(b58('A')) })).toEqual({ status: 'approved', bundle });
		} finally {
			issue.mockRestore();
		}
	});

	it('serves the first node only, its own address only, and tells a refused one', async () => {
		await answer(GUEST_IP, { invite: INVITE, request: request(b58('A')) });
		expect((await answer(GUEST_IP, { invite: INVITE, request: request(b58('B')) })).status).toBe('refused');
		expect((await answer('100.64.255.18', { invite: INVITE, request: request(b58('A')) })).status).toBe('refused');
		expect((await answer(GUEST_IP, { invite: 'another', request: request(b58('A')) })).status).toBe('refused');
		await access.rejectRequest(NET, (await store.readFounder()).requests[0]!.id);
		expect(await answer(GUEST_IP, { invite: INVITE, request: request(b58('A')) })).toEqual({ status: 'refused', reason: 'the founder refused the request' });
	});

	it('refuses an expired invite', async () => {
		const data = await store.readFounder();
		data.invites![0]!.expires = new Date(Date.now() - 1000).toISOString();
		await store.writeJSON('founder.json', data);
		expect((await answer(GUEST_IP, { invite: INVITE, request: request(b58('A')) })).status).toBe('refused');
	});
});

/** The invited node's side: delivery runs only for an enabled lishnet and leaves no helper behind when stopped. */
describe('invite delivery — invited node', () => {
	async function setup(enabled: boolean, startGuest: () => Promise<any>) {
		const dir = await mkdtemp(join(tmpdir(), 'overlay-invited-'));
		let row = { networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled, created: '', overlay: { type: 'nebula' as const, caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } };
		const access = new OverlayAccess({
			nodes: { store: (id: string) => new OverlayStore(dir, id), startGuest } as any,
			getRow: () => row,
			addNetwork: async () => {},
			listOverlayIDs: () => [NET],
			refresh: async () => {},
			emit: () => {},
		});
		const store = new OverlayStore(dir, NET);
		await store.ensureDir();
		await store.writeJSON('invite.json', { id: INVITE, founder: '100.64.0.1', expires: new Date(Date.now() + 86_400_000).toISOString() });
		await store.writeJSON('request.json', request(b58('A')));
		return { access, dir, enable: () => (row = { ...row, enabled: true }) };
	}

	// A switched-off lishnet kept handing its request in and picked up its certificate after the user switched it off.
	it('does not deliver for a switched-off lishnet, and resumes once it is switched on', async () => {
		let starts = 0;
		const { access, dir, enable } = await setup(false, async () => {
			starts++;
			throw new Error('no tunnel in a unit test');
		});
		try {
			access.resumeInvites();
			(access as any).deliver(NET);
			await Bun.sleep(50);
			expect(starts).toBe(0);
			enable();
			access.resumeInvite(NET);
			await Bun.sleep(50);
			expect(starts).toBe(1);
		} finally {
			await access.stopInvites();
			await rm(dir, { recursive: true, force: true });
		}
	});

	// A stop that came while the guest helper was starting found nothing to end, and the helper ran on, unowned.
	it('ends a guest helper that finishes starting after the delivery was stopped', async () => {
		let release!: () => void;
		let stopped = 0;
		const { access, dir } = await setup(true, () => new Promise(resolve => (release = () => resolve({ helper: { isRunning: () => true, stop: async () => void stopped++ }, vpnIP: '100.64.255.3' }))));
		try {
			access.resumeInvite(NET);
			await Bun.sleep(50);
			await access.stopInvite(NET);
			release();
			await Bun.sleep(50);
			expect(stopped).toBe(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

/** A CA key in Nebula's PEM form and its public half (hex), as the helper prints it. */
async function caKeys(): Promise<{ pem: string; publicKey: string }> {
	const key = await generateKeyPair('Ed25519');
	return { pem: `-----BEGIN NEBULA ED25519 PRIVATE KEY-----\n${Buffer.from(key.raw).toString('base64')}\n-----END NEBULA ED25519 PRIVATE KEY-----\n`, publicKey: Buffer.from(key.publicKey.raw).toString('hex') };
}

/** A member renews over the lishnet itself: its request goes to the founder and the certificate comes back the same way. */
describe('renewal over the lishnet', () => {
	async function founderSetup() {
		const dir = await mkdtemp(join(tmpdir(), 'overlay-renewal-'));
		const sent: any[] = [];
		const events: string[] = [];
		const ca = await caKeys();
		const access = new OverlayAccess({
			nodes: { network: () => undefined, store: (id: string) => new OverlayStore(dir, id), ownCertificate: async () => null, currentState: async () => null, knownRevocations: async () => ({ fingerprints: [], peers: {} }), publishNewState: async () => {}, broadcastAccess: async (_id: string, message: any) => (sent.push(message), true) } as any,
			getRow: () => ({ networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } }),
			addNetwork: async () => {},
			listOverlayIDs: () => [],
			refresh: async () => {},
			emit: event => void events.push(event),
		});
		const store = new OverlayStore(dir, NET);
		await store.ensureDir();
		await store.writeText('ca.key', ca.pem);
		// Ends in ten days: the renewal makes it longer.
		await store.writeJSON('founder.json', { nextHost: 2, lane: 0, members: [{ name: 'm', peerID: b58('A'), vpnIP: '100.64.0.7', roles: [], notAfter: new Date(Date.now() + 10 * 86_400_000).toISOString(), fingerprint: 'a'.repeat(64), issued: '', revoked: false }], requests: [] });
		return { dir, access, store, sent, events, ca };
	}

	// Renewing meant copying JSON by hand both ways, though the member is in the lishnet already.
	it('queues a renewal only from the member it names, once, and sends its certificate back', async () => {
		const f = await founderSetup();
		const issue = spyOn(OverlayAccess.prototype as any, 'issueCertificate').mockImplementation(async (...args: unknown[]) => ({ cert: 'renewed', fingerprint: 'c'.repeat(64), notAfter: args[5] as string }));
		try {
			// Signed by another node, or by a node that is no member: ignored.
			await f.access.onAccessMessage(NET, { type: 'overlayRenewal', request: request(b58('A')) }, b58('B'));
			await f.access.onAccessMessage(NET, { type: 'overlayRenewal', request: request(b58('B')) }, b58('B'));
			expect((await f.store.readFounder()).requests).toHaveLength(0);
			await f.access.onAccessMessage(NET, { type: 'overlayRenewal', request: request(b58('A')) }, b58('A'));
			await f.access.onAccessMessage(NET, { type: 'overlayRenewal', request: request(b58('A')) }, b58('A'));
			const queued = (await f.store.readFounder()).requests;
			expect(queued.map(r => r.renewal)).toEqual([true]);
			expect(f.events).toEqual(['overlay:request']);
			const bundle = await f.access.approve(NET, queued[0]!.id);
			expect(f.sent).toEqual([{ type: 'overlayCertificate', peerID: b58('A'), requestCreated: '2026-01-01T00:00:00Z', bundle, signature: expect.any(String) }]);
			expect(await verifyAnswer({ networkID: NET, peerID: b58('A'), requestCreated: '2026-01-01T00:00:00Z', certificate: 'renewed' }, f.sent[0].signature, f.ca.publicKey)).toBe(true);
			// Sent again every minute for a member that was offline when it was approved.
			await f.access.repeatAccess(NET);
			expect(f.sent).toHaveLength(2);
			// The member repeats its request until the certificate arrives: it is not queued again.
			await f.access.onAccessMessage(NET, { type: 'overlayRenewal', request: request(b58('A')) }, b58('A'));
			expect((await f.store.readFounder()).requests).toHaveLength(0);
		} finally {
			issue.mockRestore();
			await rm(f.dir, { recursive: true, force: true });
		}
	});

	// The member was not told and kept asking every minute; each copy came back as a new request.
	it('sends a refusal and does not queue the refused request again', async () => {
		const f = await founderSetup();
		try {
			await f.access.onAccessMessage(NET, { type: 'overlayRenewal', request: request(b58('A')) }, b58('A'));
			await f.access.rejectRequest(NET, (await f.store.readFounder()).requests[0]!.id);
			expect(f.sent).toEqual([{ type: 'overlayRefusal', peerID: b58('A'), requestCreated: '2026-01-01T00:00:00Z', signature: expect.any(String) }]);
			expect(await verifyAnswer({ networkID: NET, peerID: b58('A'), requestCreated: '2026-01-01T00:00:00Z' }, f.sent[0].signature, f.ca.publicKey)).toBe(true);
			await f.access.onAccessMessage(NET, { type: 'overlayRenewal', request: request(b58('A')) }, b58('A'));
			expect((await f.store.readFounder()).requests).toHaveLength(0);
			await f.access.repeatAccess(NET);
			expect(f.sent.map(m => m.type)).toEqual(['overlayRefusal', 'overlayRefusal']);
		} finally {
			await rm(f.dir, { recursive: true, force: true });
		}
	});

	async function memberSetup() {
		const dir = await mkdtemp(join(tmpdir(), 'overlay-renewed-'));
		const ca = await caKeys();
		const sent: any[] = [];
		const access = new OverlayAccess({
			nodes: { store: (id: string) => new OverlayStore(dir, id), caPublicKey: async () => ca.publicKey, broadcastAccess: async (_id: string, message: any) => (sent.push(message), true) } as any,
			getRow: () => ({ networkID: NET, name: 'n', description: '', bootstrapPeers: [], enabled: true, created: '', overlay: { type: 'nebula', caCert: 'ca', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } }),
			addNetwork: async () => {},
			listOverlayIDs: () => [],
			refresh: async () => {},
			emit: () => {},
		});
		const store = new OverlayStore(dir, NET);
		await store.ensureDir();
		await store.writeJSON('request.json', request(b58('A')));
		const sign = (requestCreated: string, certificate?: string): Promise<string> => signAnswer({ networkID: NET, peerID: b58('A'), requestCreated, ...(certificate !== undefined ? { certificate } : {}) }, ca.pem);
		return { dir, access, store, sent, sign };
	}

	// Another member replayed an older certificate of this one as the answer: imported, it took the newer one's place.
	it('takes only the certificate the CA signed for its own pending request', async () => {
		const m = await memberSetup();
		const imported: unknown[] = [];
		const take = spyOn(OverlayAccess.prototype, 'importCertificate').mockImplementation(async (bundle: unknown) => (imported.push(bundle), {}) as any);
		try {
			const bundle = (certificate: string) => ({ type: 'lish-overlay-certificate', networkID: NET, certificate });
			const now = '2026-01-01T00:00:00Z';
			await m.access.onAccessMessage(NET, { type: 'overlayCertificate', peerID: b58('B'), requestCreated: now, bundle: bundle('other'), signature: await m.sign(now, 'other') }, b58('F'));
			await m.access.onAccessMessage(NET, { type: 'overlayCertificate', peerID: b58('A'), requestCreated: '2025-01-01T00:00:00Z', bundle: bundle('older'), signature: await m.sign('2025-01-01T00:00:00Z', 'older') }, b58('F'));
			// An older certificate passed off as the answer: unsigned, or with the signature of the request it answered.
			await m.access.onAccessMessage(NET, { type: 'overlayCertificate', peerID: b58('A'), requestCreated: now, bundle: bundle('older') }, b58('F'));
			await m.access.onAccessMessage(NET, { type: 'overlayCertificate', peerID: b58('A'), requestCreated: now, bundle: bundle('older'), signature: await m.sign('2025-01-01T00:00:00Z', 'older') }, b58('F'));
			await m.access.onAccessMessage(NET, { type: 'overlayCertificate', peerID: b58('A'), requestCreated: now, bundle: bundle('mine'), signature: await m.sign(now, 'mine') }, b58('F'));
			expect(imported).toEqual([bundle('mine')]);
		} finally {
			take.mockRestore();
			await rm(m.dir, { recursive: true, force: true });
		}
	});

	it('shows a signed refusal and stops asking', async () => {
		const m = await memberSetup();
		try {
			const now = '2026-01-01T00:00:00Z';
			// A refusal anyone could send would stop a renewal the founder never refused.
			await m.access.onAccessMessage(NET, { type: 'overlayRefusal', peerID: b58('A'), requestCreated: now, signature: await m.sign(now, 'mine') }, b58('F'));
			expect(m.store.has('refusal.json')).toBe(false);
			await m.access.onAccessMessage(NET, { type: 'overlayRefusal', peerID: b58('A'), requestCreated: now, signature: await m.sign(now) }, b58('F'));
			expect(await m.store.readJSON<{ requestCreated: string }>('refusal.json')).toEqual({ requestCreated: now });
			await m.access.repeatAccess(NET);
			expect(m.sent).toEqual([]);
		} finally {
			await rm(m.dir, { recursive: true, force: true });
		}
	});
});

describe('invite text', () => {
	it('round-trips and rejects anything that is not an invite', () => {
		const invite: OverlayInvite = { type: 'lish-overlay-invite', id: INVITE, network: { networkID: NET, name: 'Síť', description: '', bootstrapPeers: [], overlay: { type: 'nebula', caCert: '-----BEGIN NEBULA CERTIFICATE V2-----\nAA\n-----END NEBULA CERTIFICATE V2-----\n', subnet: '100.64.0.0/16', lighthouses: [], relays: [], lanDirect: false, version: 0 } }, founder: '100.64.0.1', cert: '-----BEGIN NEBULA CERTIFICATE V2-----\nBB\n-----END NEBULA CERTIFICATE V2-----\n', key: '-----BEGIN NEBULA X25519 PRIVATE KEY-----\nCC\n-----END NEBULA X25519 PRIVATE KEY-----\n', expires: '2099-01-01T00:00:00Z' };
		const text = encodeInvite(invite);
		expect(text).toStartWith('lishinvite:');
		expect(decodeInvite(text)).toEqual(invite);
		expect(() => decodeInvite('lishinvite:bm90IGpzb24=')).toThrow('not an invite');
		expect(() => decodeInvite(JSON.stringify({ ...invite, founder: '10.0.0.1' }))).toThrow('founder');
	});
});
