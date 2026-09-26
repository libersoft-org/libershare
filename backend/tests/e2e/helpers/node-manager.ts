import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

/**
 * Real backend processes for the e2e suite, each fully isolated: its own data directory and
 * storage paths, API and P2P ports chosen by the OS, and every discovery or relay mechanism
 * switched off before the node is built — so two runs on one machine never see each other,
 * the user's own node or the internet.
 */
export interface TestNode {
	readonly dataDir: string;
	/** Set once the node reports its API port; empty while it is still starting. */
	url: string;
	readonly process: ReturnType<typeof Bun.spawn>;
}

const REPO = resolve(import.meta.dir, '../../../..');
const READY_TIMEOUT_MS = 60_000;
const nodes: TestNode[] = [];
/**
 * One random API token per run. Without it the nodes' API — file access included — would be
 * open to every other process on the machine for as long as the suite runs.
 */
export const TEST_API_TOKEN: string = randomBytes(32).toString('hex');
let root: string | null = null;

/** Settings written before the first start — nothing may fall back to the defaults. */
function isolatedSettings(dataDir: string): Record<string, unknown> {
	const storage = (name: string): string => {
		const dir = join(dataDir, 'storage', name);
		mkdirSync(dir, { recursive: true });
		return dir;
	};
	return {
		storage: { downloadPath: storage('finished'), tempPath: storage('temp'), lishPath: storage('lish'), lishnetPath: storage('lishnet'), backupPath: storage('backup') },
		network: {
			incomingPort: 0,
			mdnsEnabled: false,
			upnpEnabled: false,
			allowRelay: false,
			useRelayClients: false,
			autoStartSharing: true,
			autoStartDownloading: false,
			autoConnectNewNetworks: false,
			peerExchange: { enabled: false },
		},
	};
}

/** Resolve with the API port once the process logs it; reject if it exits or never does. */
async function waitForApiPort(proc: ReturnType<typeof Bun.spawn>, log: string[]): Promise<number> {
	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	const deadline = Date.now() + READY_TIMEOUT_MS;
	const exited = proc.exited.then(code => ({ exited: code }));
	while (Date.now() < deadline) {
		const next = await Promise.race([reader.read(), exited, Bun.sleep(deadline - Date.now()).then(() => ({ timeout: true }))]);
		if ('exited' in next) throw new Error(`backend exited with ${next.exited} before it was ready:\n${log.slice(-20).join('\n')}`);
		if ('timeout' in next || next.done) break;
		buffer += decoder.decode(next.value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) {
			log.push(line);
			const match = /WebSocket server listening on wss?:\/\/[^\s]*:(\d+)/.exec(line);
			if (match) {
				// Keep draining stdout so a full pipe can never stall the node.
				void (async () => {
					for (;;) {
						const rest = await reader.read().catch(() => ({ done: true, value: undefined }));
						if (rest.done) return;
					}
				})();
				return Number(match[1]);
			}
		}
	}
	throw new Error(`backend was not ready within ${READY_TIMEOUT_MS} ms:\n${log.slice(-20).join('\n')}`);
}

/** Start `count` isolated backends; on any failure the ones already started are stopped. */
export async function startNodes(count: number = 3): Promise<void> {
	root = mkdtempSync(join(tmpdir(), 'lish-e2e-'));
	try {
		for (let i = 0; i < count; i++) {
			const dataDir = join(root, `node${i}`);
			mkdirSync(dataDir, { recursive: true });
			writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(isolatedSettings(dataDir)));
			const env: Record<string, string> = { ...(process.env as Record<string, string>), MEMTRACE: '0', HEAP_TRIGGER: '0' };
			env['LISH_TOKEN'] = TEST_API_TOKEN;
			const proc = Bun.spawn([process.execPath, 'run', 'backend/src/app.ts', '--datadir', dataDir, '--port', '0', '--host', '127.0.0.1'], { cwd: REPO, env, stdout: 'pipe', stderr: 'inherit' });
			// Tracked from the spawn, so a node that never gets ready is stopped — and waited
			// for — like every other one before its directory is removed.
			const node: TestNode = { dataDir, url: '', process: proc };
			nodes.push(node);
			const port = await waitForApiPort(proc, []);
			node.url = `ws://127.0.0.1:${port}?token=${TEST_API_TOKEN}`;
		}
	} catch (error) {
		await stopNodes();
		throw error;
	}
}

/** Stop every node this module started and remove their data, waiting for each exit. */
export async function stopNodes(): Promise<void> {
	for (const node of nodes.splice(0)) {
		node.process.kill();
		await Promise.race([node.process.exited, Bun.sleep(10_000)]);
		if (node.process.exitCode === null) node.process.kill(9);
		await node.process.exited;
	}
	if (root && process.env['LISH_E2E_KEEP']) {
		// Debugging aid: keep the data directories (each has the node's own log file).
		console.log(`[e2e] test node data kept in ${root}`);
		root = null;
	}
	if (root) {
		// Windows keeps handles for a moment after exit; retry briefly, then report.
		for (let attempt = 0; ; attempt++) {
			try {
				rmSync(root, { recursive: true, force: true });
				break;
			} catch (error) {
				if (attempt >= 20) throw error;
				await Bun.sleep(250);
			}
		}
		root = null;
	}
}

export function getNodeURL(index: number): string {
	const node = nodes[index];
	if (!node) throw new Error(`no test node ${index}`);
	return node.url;
}

export function getNodeDataDir(index: number): string {
	const node = nodes[index];
	if (!node) throw new Error(`no test node ${index}`);
	return node.dataDir;
}
