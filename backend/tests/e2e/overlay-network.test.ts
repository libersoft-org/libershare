import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Subprocess } from 'bun';
import { API, WsClient, type LISHNetworkConfig, type OverlayStatus } from '@shared';
import { overlayBinaryPath } from '../../src/overlay/overlay-binary.ts';

/**
 * A protected lishnet end to end, on loopback, with three real backends driven only through the API — the same
 * way an external service would drive the founder: create, request, issue, import, share, download, revoke.
 * Hiding of public addresses cannot be observed on loopback (everyone is 127.0.0.1); the fleet test covers it.
 */

const APP = join(import.meta.dir, '..', '..', 'src', 'app.ts');
const TOKEN = randomBytes(24).toString('hex');

interface Node {
	name: string;
	dir: string;
	proc: Subprocess;
	api: API;
	client: WsClient;
	/** The public node's TCP port. */
	p2pPort: number;
}

async function freePort(kind: 'tcp' | 'udp'): Promise<number> {
	if (kind === 'udp') {
		const socket = createSocket('udp4');
		await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve));
		const port = socket.address().port;
		socket.close();
		return port;
	}
	const server = createServer();
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as any).port as number;
	await new Promise(resolve => server.close(resolve));
	return port;
}

async function until<T>(what: string, check: () => Promise<T | undefined | null | false>, timeoutMs = 60_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			const value = await check();
			if (value) return value;
		} catch (err) {
			last = err;
		}
		await Bun.sleep(500);
	}
	throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ''}`);
}

async function startNode(root: string, name: string): Promise<Node> {
	const dir = join(root, name);
	await mkdir(dir, { recursive: true });
	const storage = Object.fromEntries(['downloadPath', 'tempPath', 'lishPath', 'lishnetPath', 'backupPath'].map(k => [k, join(dir, k) + '/']));
	const p2pPort = await freePort('tcp');
	await writeFile(join(dir, 'settings.json'), JSON.stringify({ network: { incomingPort: p2pPort, mdnsEnabled: false, upnpEnabled: false }, storage }));
	const apiPort = await freePort('tcp');
	const proc = Bun.spawn(['bun', APP, '--datadir', dir, '--port', String(apiPort), '--host', '127.0.0.1', '--token', TOKEN, '--loglevel', 'debug', '--logfile', join(dir, 'backend.log')], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
	await until(`${name} API`, async () => (await fetch(`http://127.0.0.1:${apiPort}/health`)).ok, 60_000);
	const client = new WsClient(`ws://127.0.0.1:${apiPort}/?token=${TOKEN}`, () => {});
	return { name, dir, proc, api: new API(client), client, p2pPort };
}

describe('protected lishnet on loopback', () => {
	let root: string;
	let founder: Node, alice: Node, bob: Node;
	let network: LISHNetworkConfig;
	let protectedLish = '';
	const nodes = (): Node[] => [founder, alice, bob].filter(Boolean);

	beforeAll(async () => {
		overlayBinaryPath(); // fails loudly when the helper is not built (bun overlay/build.ts)
		root = await mkdtemp(join(tmpdir(), 'lish-overlay-e2e-'));
		const started = await Promise.all(['founder', 'alice', 'bob'].map(n => startNode(root, n)));
		[founder, alice, bob] = [started[0]!, started[1]!, started[2]!];
	}, 120_000);

	afterAll(async () => {
		for (const n of nodes()) {
			n.client.destroy?.();
			n.proc.kill();
			await n.proc.exited;
		}
		// OVERLAY_E2E_KEEP=1 keeps the three data directories and their debug logs for a post-mortem.
		if (!process.env['OVERLAY_E2E_KEEP']) await rm(root, { recursive: true, force: true }).catch(() => {});
	}, 60_000);

	/** A member joins the way a user would: import the definition, ask, get approved by the founder's API, import. */
	async function joinMember(member: Node, name: string, validUntil?: string): Promise<OverlayStatus> {
		await member.api.lishnets.add({ ...network, enabled: true });
		const request = await member.api.overlay.requestAccess(network.networkID, name);
		expect(request.publicKey).toContain('NEBULA X25519 PUBLIC KEY');
		expect(JSON.stringify(request)).not.toContain('PRIVATE');
		const bundle = await founder.api.overlay.issue(request, validUntil ? { validUntil } : {});
		return await member.api.overlay.importCertificate(bundle);
	}

	it('the founder creates the lishnet and runs it as lighthouse and relay', async () => {
		network = await founder.api.overlay.create({ name: 'E2E protected', lighthouseAddr: `127.0.0.1:${await freePort('udp')}` });
		expect(network.overlay?.lighthouses).toHaveLength(1);
		const status = await until('founder node', async () => {
			const s = await founder.api.overlay.status(network.networkID);
			return s.running ? s : null;
		});
		expect(status.role).toBe('founder');
		expect(status.certificate?.vpnIP).toBe('100.64.0.1');
	}, 60_000);

	it('members get certificates through the API and join under overlay addresses only', async () => {
		const a = await joinMember(alice, 'Alice');
		const b = await joinMember(bob, 'Bob', new Date(Date.now() + 3600_000).toISOString());
		expect(a.role).toBe('member');
		// Addresses follow from the peer ID: inside the subnet, never the founder's .1, never one another's.
		for (const s of [a, b]) expect(s.certificate?.vpnIP).toMatch(/^100\.64\.\d+\.\d+$/);
		expect(new Set(['100.64.0.1', a.certificate?.vpnIP, b.certificate?.vpnIP]).size).toBe(3);
		const members = await founder.api.overlay.listMembers(network.networkID);
		expect(members.map(m => m.name).sort()).toEqual(['Alice', 'Bob', 'E2E protected']);
		for (const member of [alice, bob]) {
			const info = await until(`${member.name} overlay node`, async () => (await member.api.lishnets.infoAll()).find(n => n.networkID === network.networkID && n.peerID));
			expect(info.addresses!.length).toBeGreaterThan(0);
			for (const addr of info.addresses!) expect(addr).toMatch(/^\/ip4\/100\.64\.\d+\.\d+\/tcp\/9090/);
			// Its own identity: not the public node's.
			expect(info.peerID).not.toBe((await member.api.lishnets.getNodeInfo())?.peerID);
		}
		const bobPeer = (await bob.api.lishnets.infoAll()).find(n => n.networkID === network.networkID)!.peerID!;
		await until('alice sees bob in the topic', async () => (await alice.api.lishnets.getPeers(network.networkID)).some(p => p.peerID === bobPeer), 90_000);
	}, 180_000);

	it('a file shared by one member downloads to another through the overlay', async () => {
		const source = join(alice.dir, 'share');
		await mkdir(source, { recursive: true });
		const content = randomBytes(3 * 1024 * 1024 + 123);
		await writeFile(join(source, 'payload.bin'), content);
		const { lishID } = await alice.api.lishs.create(source, undefined, true, false, 'payload', undefined, undefined, undefined, undefined, undefined, undefined, undefined, [network.networkID]);
		protectedLish = lishID;
		const alicePeer = (await alice.api.lishnets.infoAll()).find(n => n.networkID === network.networkID)!.peerID!;
		await until('bob sees the lish', async () => (await bob.api.lishnets.getPeerLishs(alicePeer, network.networkID)).lishs?.some(l => l.id === lishID), 60_000);
		await bob.api.lishnets.addPeerLish(lishID, alicePeer, network.networkID);
		const downloaded = await until<Buffer>(
			'download',
			async () => {
				// Wherever the download landed under the download directory.
				const found = [...new Bun.Glob('**/payload.bin').scanSync(join(bob.dir, 'downloadPath'))][0];
				if (!found) return null;
				const file = join(bob.dir, 'downloadPath', found);
				const data = await readFile(file).catch(() => null);
				return data && data.length === content.length ? data : null;
			},
			120_000
		);
		expect(createHash('sha256').update(downloaded).digest('hex')).toBe(createHash('sha256').update(content).digest('hex'));
		// What came from the protected lishnet is shared back into it only.
		expect((await bob.api.lishs.get(lishID))?.scope).toEqual([network.networkID]);
	}, 240_000);

	it('a LISH shared in the protected lishnet stays off a public lishnet, and a public one off the protected', async () => {
		// The dial filter refuses loopback on purpose (no remote peer reaches it), so the host's own address it is.
		const hostIP = Object.values(networkInterfaces())
			.flat()
			.find(i => i?.family === 'IPv4' && !i.internal)?.address;
		if (!hostIP) throw new Error('the public-lishnet check needs a non-loopback IPv4 address');
		const aliceNode = (await alice.api.lishnets.getNodeInfo())!;
		const publicNet = { networkID: crypto.randomUUID(), name: 'E2E public', description: '', created: new Date().toISOString(), enabled: true };
		await alice.api.lishnets.add({ ...publicNet, bootstrapPeers: [] });
		await bob.api.lishnets.add({ ...publicNet, bootstrapPeers: [`/ip4/${hostIP}/tcp/${alice.p2pPort}/p2p/${aliceNode.peerID}`] });
		await until('bob meets alice on the public lishnet', async () => (await bob.api.lishnets.getPeers(publicNet.networkID)).some(p => p.peerID === aliceNode.peerID), 60_000);
		const source = join(alice.dir, 'public-share');
		await mkdir(source, { recursive: true });
		await writeFile(join(source, 'public.bin'), randomBytes(64 * 1024));
		const { lishID: publicLish } = await alice.api.lishs.create(source, undefined, true, false, 'public');
		const publicList = await until('bob lists alice on the public lishnet', async () => {
			const list = (await bob.api.lishnets.getPeerLishs(aliceNode.peerID, publicNet.networkID)).lishs;
			return list?.some(l => l.id === publicLish) ? list : null;
		});
		expect(publicList.some(l => l.id === protectedLish)).toBe(false);
		const alicePeer = (await alice.api.lishnets.infoAll()).find(n => n.networkID === network.networkID)!.peerID!;
		const protectedList = (await bob.api.lishnets.getPeerLishs(alicePeer, network.networkID)).lishs ?? [];
		expect(protectedList.map(l => l.id)).toEqual([protectedLish]);
		await alice.api.lishnets.delete(publicNet.networkID);
		await bob.api.lishnets.delete(publicNet.networkID);
	}, 120_000);

	// Nebula takes the lighthouse role and the listen port at start only: a running member approved as a host kept
	// listening on its random port while everyone was told to reach it on the new one.
	it('a running member approved as lighthouse and relay starts listening on its port', async () => {
		const port = await freePort('udp');
		const request = await alice.api.overlay.requestAccess(network.networkID, 'Alice', `127.0.0.1:${port}`);
		await alice.api.overlay.importCertificate(await founder.api.overlay.issue(request, { roles: ['lighthouse', 'relay'] }));
		const bound = (): Promise<boolean> =>
			new Promise(resolve => {
				const socket = createSocket('udp4');
				socket.once('error', () => resolve(true));
				socket.bind(port, '127.0.0.1', () => socket.close(() => resolve(false)));
			});
		await until("alice's helper on its lighthouse port", bound, 60_000);
		const status = await alice.api.overlay.status(network.networkID);
		expect(
			status.hosts
				.filter(h => h.self)
				.map(h => h.role)
				.sort()
		).toEqual(['lighthouse', 'relay']);
		const alicePeer = (await alice.api.lishnets.infoAll()).find(n => n.networkID === network.networkID)!.peerID!;
		await until('bob sees alice again', async () => (await bob.api.lishnets.getPeers(network.networkID)).some(p => p.peerID === alicePeer), 90_000);
	}, 180_000);

	it('a revoked member is cut off from everyone', async () => {
		const bobStatus = await bob.api.overlay.status(network.networkID);
		const bobPeer = (await bob.api.lishnets.infoAll()).find(n => n.networkID === network.networkID)!.peerID!;
		await founder.api.overlay.revoke(network.networkID, bobStatus.certificate!.fingerprint);
		expect((await founder.api.overlay.listMembers(network.networkID)).find(m => m.name === 'Bob')?.revoked).toBe(true);
		// Nebula drops the tunnels at once (disconnect_invalid) and the helper closes the bridged connections with them.
		const revokedAt = Date.now();
		await until('alice loses bob', async () => !(await alice.api.lishnets.getPeers(network.networkID)).some(p => p.peerID === bobPeer), 15_000);
		console.log(`revoked member gone from alice after ${Date.now() - revokedAt} ms`);
		const after = await until('alice holds the new state', async () => {
			const s = await alice.api.overlay.status(network.networkID);
			return s.stateVersion > 0 ? s : null;
		});
		expect(after.peers.some(p => p.vpnIP === bobStatus.certificate!.vpnIP)).toBe(false);
	}, 120_000);

	it('a revoked member approved again rejoins under its new address', async () => {
		const old = (await bob.api.overlay.status(network.networkID)).certificate!;
		const bobPeer = (await bob.api.lishnets.infoAll()).find(n => n.networkID === network.networkID)!.peerID!;
		const request = await bob.api.overlay.requestAccess(network.networkID, 'Bob');
		const status = await bob.api.overlay.importCertificate(await founder.api.overlay.issue(request, {}));
		// A revoked address is not handed out again, so the node has to move to the new one.
		expect(status.certificate!.vpnIP).not.toBe(old.vpnIP);
		expect(status.certificate!.revoked).toBe(false);
		await until('alice sees bob again', async () => (await alice.api.lishnets.getPeers(network.networkID)).some(p => p.peerID === bobPeer), 90_000);
		const info = (await bob.api.lishnets.infoAll()).find(n => n.networkID === network.networkID)!;
		for (const addr of info.addresses!) expect(addr).toContain(`/ip4/${status.certificate!.vpnIP}/`);
	}, 150_000);

	// Renewing took JSON copied by hand both ways, though the member is in the lishnet already.
	it('a member renews over the lishnet: the request and the certificate travel by themselves', async () => {
		const held = (await bob.api.overlay.status(network.networkID)).certificate!;
		await bob.api.overlay.requestAccess(network.networkID, 'Bob');
		const pending = await until('the renewal reaches the founder', async () => (await founder.api.overlay.listRequests(network.networkID)).find(r => r.renewal && r.name === 'Bob'), 90_000);
		await founder.api.overlay.approve(network.networkID, pending.id, { validUntil: new Date(Date.now() + 400 * 86_400_000).toISOString() });
		const renewed = await until(
			'bob takes the renewed certificate',
			async () => {
				const s = await bob.api.overlay.status(network.networkID);
				return s.certificate && s.certificate.fingerprint !== held.fingerprint && !s.request ? s : null;
			},
			90_000
		);
		expect(renewed.certificate!.vpnIP).toBe(held.vpnIP);
		expect(renewed.certificate!.revoked).toBe(false);
	}, 200_000);

	// Approved shorter while the member was switched off, it was revoked at once and could not fetch the new certificate.
	it('a shorter renewal reaches a member that was offline, which keeps its longer certificate until then', async () => {
		const held = (await bob.api.overlay.status(network.networkID)).certificate!;
		await bob.api.overlay.requestAccess(network.networkID, 'Bob');
		const pending = await until('the renewal reaches the founder', async () => (await founder.api.overlay.listRequests(network.networkID)).find(r => r.renewal && r.name === 'Bob'), 90_000);
		await bob.api.lishnets.setEnabled(network.networkID, false);
		const stateBefore = (await founder.api.overlay.status(network.networkID)).stateVersion;
		await founder.api.overlay.approve(network.networkID, pending.id, { validUntil: new Date(Date.now() + 2 * 3600_000).toISOString() });
		const rows = (await founder.api.overlay.listMembers(network.networkID)).filter(m => m.name === 'Bob');
		expect(rows.find(m => m.fingerprint === held.fingerprint)?.revoked).toBe(false);
		// The limit on the longer certificate is in a new signed state.
		expect((await founder.api.overlay.status(network.networkID)).stateVersion).toBeGreaterThan(stateBefore);
		await bob.api.lishnets.setEnabled(network.networkID, true);
		const renewed = await until(
			'bob takes the shorter certificate over the lishnet',
			async () => {
				const s = await bob.api.overlay.status(network.networkID);
				return s.certificate && s.certificate.fingerprint !== held.fingerprint && !s.request ? s : null;
			},
			120_000
		);
		expect(Date.parse(renewed.certificate!.notAfter) - Date.now()).toBeLessThan(3 * 3600_000);
		expect(renewed.certificate!.vpnIP).toBe(held.vpnIP);
		expect(renewed.certificate!.revoked).toBe(false);
		const bobPeer = (await bob.api.lishnets.infoAll()).find(n => n.networkID === network.networkID)!.peerID!;
		await until('alice sees bob on the shorter certificate', async () => (await alice.api.lishnets.getPeers(network.networkID)).some(p => p.peerID === bobPeer), 90_000);
	}, 300_000);

	it("revoking any of a member's certificates revokes the member", async () => {
		const shorter = (await bob.api.overlay.status(network.networkID)).certificate!;
		// An extension: the shorter certificate stays valid next to the longer one.
		const request = await bob.api.overlay.requestAccess(network.networkID, 'Bob');
		const longer = await bob.api.overlay.importCertificate(await founder.api.overlay.issue(request, { validUntil: new Date(Date.now() + 2 * 86_400_000).toISOString() }));
		expect(longer.certificate!.fingerprint).not.toBe(shorter.fingerprint);
		const bobPeer = (await bob.api.lishnets.infoAll()).find(n => n.networkID === network.networkID)!.peerID!;
		await until('alice sees bob on the longer certificate', async () => (await alice.api.lishnets.getPeers(network.networkID)).some(p => p.peerID === bobPeer), 90_000);
		await founder.api.overlay.revoke(network.networkID, shorter.fingerprint);
		expect((await founder.api.overlay.listMembers(network.networkID)).filter(m => m.name === 'Bob').every(m => m.revoked)).toBe(true);
		await until('alice loses bob', async () => !(await alice.api.lishnets.getPeers(network.networkID)).some(p => p.peerID === bobPeer), 15_000);
		expect((await bob.api.overlay.status(network.networkID)).certificate?.revoked).toBe(true);
	}, 150_000);

	it('deleting a protected lishnet removes its keys, certificate and node data', async () => {
		const nodeDir = join(bob.dir, 'lishnet-nodes', network.networkID);
		expect(existsSync(join(nodeDir, 'member.key'))).toBe(true);
		await bob.api.lishnets.delete(network.networkID);
		await until('bob forgets the lishnet', async () => !existsSync(nodeDir), 30_000);
		expect((await bob.api.lishnets.infoAll()).some(n => n.networkID === network.networkID)).toBe(false);
	}, 60_000);

	// No JSON passed by hand: the invited node hands its request in over the overlay and picks its certificate up there.
	it('a node joins through an invite: the request and the certificate travel by themselves', async () => {
		const { invite } = await founder.api.overlay.createInvite(network.networkID);
		expect(invite).toStartWith('lishinvite:');
		await bob.api.overlay.useInvite(invite, 'Bob by invite');
		const pending = await until('the request reaches the founder', async () => (await founder.api.overlay.listRequests(network.networkID)).find(r => r.name === 'Bob by invite'), 90_000);
		expect(pending.invite).toBeDefined();
		await until('bob waits for the approval', async () => (await bob.api.overlay.status(network.networkID)).invite?.state === 'pending', 60_000);
		await founder.api.overlay.approve(network.networkID, pending.id);
		const status = await until(
			'bob gets the certificate',
			async () => {
				const s = await bob.api.overlay.status(network.networkID);
				return s.role === 'member' && !s.invite ? s : null;
			},
			90_000
		);
		const nodeDir = join(bob.dir, 'lishnet-nodes', network.networkID);
		expect(existsSync(join(nodeDir, 'guest.key'))).toBe(false);
		const bobPeer = await until('bob node', async () => (await bob.api.lishnets.infoAll()).find(n => n.networkID === network.networkID && n.peerID)?.peerID);
		await until('alice sees bob', async () => (await alice.api.lishnets.getPeers(network.networkID)).some(p => p.peerID === bobPeer), 90_000);
		expect(status.certificate?.revoked).toBe(false);
		await bob.api.lishnets.delete(network.networkID);
		await until('bob forgets the lishnet', async () => !existsSync(nodeDir), 30_000);
	}, 300_000);

	// A founder restored on a clean device could approve others but not join: it had no certificate of its own.
	it('a founder restored from the key backup on a clean device joins its lishnet', async () => {
		const { caKey } = await founder.api.overlay.exportCA(network.networkID);
		await bob.api.lishnets.add({ ...network, enabled: true });
		await bob.api.overlay.importCA(network.networkID, caKey);
		const status = await until('the restored founder runs', async () => {
			const s = await bob.api.overlay.status(network.networkID);
			return s.running && s.certificate ? s : null;
		});
		expect(status.role).toBe('founder');
		expect(status.certificate!.revoked).toBe(false);
		// The backup carried the member list, so the new address is a free one.
		const taken = (await founder.api.overlay.listMembers(network.networkID)).map(m => m.vpnIP);
		expect(taken).not.toContain(status.certificate!.vpnIP);
		const bobPeer = (await bob.api.lishnets.infoAll()).find(n => n.networkID === network.networkID)!.peerID!;
		await until('alice sees the restored founder', async () => (await alice.api.lishnets.getPeers(network.networkID)).some(p => p.peerID === bobPeer), 90_000);
	}, 150_000);
});
