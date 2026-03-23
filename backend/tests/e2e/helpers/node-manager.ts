import { join } from 'path';
import { NODE1_API_PORT, NODE2_API_PORT, NODE3_API_PORT, NODE1_P2P_PORT, NODE2_P2P_PORT, NODE3_P2P_PORT, TEST_DATA_PREFIX } from './constants.ts';

interface NodeInfo {
	proc: ReturnType<typeof Bun.spawn>;
	apiPort: number;
	p2pPort: number;
	dataDir: string;
}

const ROOT = join(import.meta.dir, '..', '..', '..');
const APP_ENTRY = join(ROOT, 'backend', 'src', 'app.ts');

const nodes: NodeInfo[] = [];

function settingsJSON(p2pPort: number, storageSuffix: string): string {
	return JSON.stringify({
		network: {
			incomingPort: p2pPort,
			maxDownloadConnections: 200,
			maxUploadConnections: 200,
			maxDownloadSpeed: 0,
			maxUploadSpeed: 0,
			allowRelay: true,
			maxRelayReservations: 100,
			autoStartSharing: true,
			announceAddresses: [],
		},
		storage: {
			downloadPath: `~/LiberShare-Test-${storageSuffix}/finished/`,
			tempPath: `~/LiberShare-Test-${storageSuffix}/temp/`,
			lishPath: `~/LiberShare-Test-${storageSuffix}/lish/`,
			lishnetPath: `~/LiberShare-Test-${storageSuffix}/lishnet/`,
		},
	}, null, '\t');
}

async function copyDir(src: string, dst: string): Promise<void> {
	const { mkdir, readdir, copyFile } = await import('fs/promises');
	await mkdir(dst, { recursive: true });
	const entries = await readdir(src, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = join(src, entry.name);
		const dstPath = join(dst, entry.name);
		if (entry.isDirectory()) await copyDir(srcPath, dstPath);
		else await copyFile(srcPath, dstPath);
	}
}

async function rmDir(dir: string): Promise<void> {
	try {
		const { rm } = await import('fs/promises');
		await rm(dir, { recursive: true, force: true });
	} catch {}
}

async function waitForPort(port: number, timeout = 10000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		try {
			const res = await fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(1000) });
			await res.text();
			return; // server responds (even with error)
		} catch {
			await new Promise(r => setTimeout(r, 300));
		}
	}
	throw new Error(`Port ${port} not ready after ${timeout}ms`);
}

export async function startNodes(): Promise<void> {
	const configs = [
		{ apiPort: NODE1_API_PORT, p2pPort: NODE1_P2P_PORT, suffix: '1', sourceData: join(ROOT, '.node1') },
		{ apiPort: NODE2_API_PORT, p2pPort: NODE2_P2P_PORT, suffix: '2', sourceData: null },
		{ apiPort: NODE3_API_PORT, p2pPort: NODE3_P2P_PORT, suffix: '3', sourceData: null },
	];

	for (const cfg of configs) {
		const dataDir = join(ROOT, `${TEST_DATA_PREFIX}${cfg.suffix}`);
		await rmDir(dataDir);

		if (cfg.sourceData) {
			// Copy node1 data (has the test LISH)
			await copyDir(cfg.sourceData, dataDir);
			// Overwrite settings with test ports
			await Bun.write(join(dataDir, 'settings.json'), settingsJSON(cfg.p2pPort, cfg.suffix));
		} else {
			// Create empty node with settings
			const { mkdir } = await import('fs/promises');
			await mkdir(dataDir, { recursive: true });
			await Bun.write(join(dataDir, 'settings.json'), settingsJSON(cfg.p2pPort, cfg.suffix));
		}

		const proc = Bun.spawn(['bun', 'run', APP_ENTRY, '--datadir', dataDir, '--port', String(cfg.apiPort), '--host', 'localhost', '--loglevel', 'warn'], {
			cwd: ROOT,
			stdout: 'pipe',
			stderr: 'pipe',
		});

		nodes.push({ proc, apiPort: cfg.apiPort, p2pPort: cfg.p2pPort, dataDir });
	}

	// Wait for all API ports to be ready
	await Promise.all(nodes.map(n => waitForPort(n.apiPort, 15000)));
	console.log(`[NodeManager] All ${nodes.length} nodes started`);
}

export async function stopNodes(): Promise<void> {
	for (const node of nodes) {
		node.proc.kill();
		await node.proc.exited;
	}
	// Clean up test data dirs
	for (const node of nodes) {
		await rmDir(node.dataDir);
	}
	nodes.length = 0;
	console.log('[NodeManager] All nodes stopped and cleaned up');
}

export function getNodeURL(index: 0 | 1 | 2): string {
	const ports = [NODE1_API_PORT, NODE2_API_PORT, NODE3_API_PORT];
	return `ws://localhost:${ports[index]}`;
}
