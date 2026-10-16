import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { tmpdir } from 'node:os';
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
	await writeFile(join(dir, 'settings.json'), JSON.stringify({ network: { incomingPort: await freePort('tcp'), mdnsEnabled: false, upnpEnabled: false }, storage }));
	const apiPort = await freePort('tcp');
	const proc = Bun.spawn(['bun', APP, '--datadir', dir, '--port', String(apiPort), '--host', '127.0.0.1', '--token', TOKEN, '--loglevel', 'debug', '--logfile', join(dir, 'backend.log')], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
	await until(`${name} API`, async () => (await fetch(`http://127.0.0.1:${apiPort}/health`)).ok, 60_000);
	const client = new WsClient(`ws://127.0.0.1:${apiPort}/?token=${TOKEN}`, () => {});
	return { name, dir, proc, api: new API(client), client };
}

describe('protected lishnet on loopback', () => {
	let root: string;
	let founder: Node, alice: Node, bob: Node;
	let network: LISHNetworkConfig;
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
		expect(a.certificate?.vpnIP).toBe('100.64.0.2');
		expect(b.certificate?.vpnIP).toBe('100.64.0.3');
		const members = await founder.api.overlay.listMembers(network.networkID);
		expect(members.map(m => m.name).sort()).toEqual(['Alice', 'Bob', 'E2E protected']);
		for (const member of [alice, bob]) {
			const info = await until(`${member.name} overlay node`, async () => (await member.api.lishnets.infoAll()).find(n => n.networkID === network.networkID && n.peerID));
			expect(info.addresses!.length).toBeGreaterThan(0);
			for (const addr of info.addresses!) expect(addr).toMatch(/^\/ip4\/100\.64\.0\.\d+\/tcp\/9090/);
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
		const { lishID } = await alice.api.lishs.create(source, undefined, true, false, 'payload');
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
	}, 240_000);

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
});
