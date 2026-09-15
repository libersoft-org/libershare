import { dirname, join } from 'path';
import { installRuntimeErrorHandlers } from './runtime-errors.ts';
import { productName, productVersion } from '@shared';
import { resolveHealthcheckPort } from './healthcheck.ts';
import { setupLogger, type LogLevel } from './logger.ts';
import { Networks } from './lishnet/lishnets.ts';
import { DataServer } from './lish/data-server.ts';
import { openDatabase } from './db/database.ts';
import { APIServer } from './api/api.ts';
import { Settings } from './settings.ts';
import { startMemoryTrace } from './monitoring/memory-trace.ts';
import { startHeapSnapshotTrigger } from './monitoring/heap-snapshot.ts';

// Parse command line arguments
const args = process.argv.slice(2);
// Default dataDir: next to binary if compiled, otherwise ./data (relative to CWD)
const isCompiledBinary = process.execPath !== Bun.which('bun');
let dataDir = isCompiledBinary ? join(dirname(process.execPath), 'data') : './data';

let logLevel: LogLevel = isCompiledBinary ? 'info' : 'debug';
let apiHost = 'localhost';
let apiPort = 0;
let apiSecure = false;
let apiKeyFile: string | undefined;
let apiCertFile: string | undefined;
let apiToken: string | undefined = process.env['LISH_TOKEN'];
let logFile: string | undefined;

for (let i = 0; i < args.length; i++) {
	if (args[i] === '--datadir' && i + 1 < args.length) {
		dataDir = args[i + 1]!;
		i++;
	} else if (args[i] === '--loglevel' && i + 1 < args.length) {
		logLevel = args[i + 1]! as LogLevel;
		i++;
	} else if (args[i] === '--host' && i + 1 < args.length) {
		apiHost = args[i + 1]!;
		i++;
	} else if (args[i] === '--port' && i + 1 < args.length) {
		apiPort = parseInt(args[i + 1]!, 10);
		i++;
	} else if (args[i] === '--secure') apiSecure = true;
	else if (args[i] === '--privkey' && i + 1 < args.length) {
		apiKeyFile = args[i + 1];
		i++;
	} else if (args[i] === '--pubkey' && i + 1 < args.length) {
		apiCertFile = args[i + 1];
		i++;
	} else if (args[i] === '--token' && i + 1 < args.length) {
		apiToken = args[i + 1]!;
		i++;
	} else if (args[i] === '--logfile' && i + 1 < args.length) {
		logFile = args[i + 1]!;
		i++;
	}
}

// Self-healthcheck mode used by docker-compose / orchestrators. Performs a
// single HTTP GET against the running instance's `/health` endpoint and exits
// 0 on 2xx, 1 otherwise — no logger setup, no DB open, no libp2p init.
if (args.includes('--healthcheck')) {
	const decision = resolveHealthcheckPort(apiPort, process.env['BACKEND_PORT']);
	if (decision.exit !== undefined) {
		if (decision.message) console.error(decision.message);
		process.exit(decision.exit);
	}
	// Try IPv4 first, then IPv6 — `--host localhost` on Windows binds only to
	// `[::1]` while the same flag in a Docker container binds to `127.0.0.1`.
	// Probing both addresses keeps the self-flag portable across deployments.
	const targets = [`http://127.0.0.1:${decision.port}/health`, `http://[::1]:${decision.port}/health`];
	for (const target of targets) {
		try {
			const res = await fetch(target, { signal: AbortSignal.timeout(2500) });
			if (res.ok) process.exit(0);
		} catch {
			// Try the next address.
		}
	}
	process.exit(1);
}

setupLogger(logLevel, logFile ?? join(dataDir, `${productName.toLowerCase()}.log`));
const header = `${productName} v${productVersion}`;
console.log('='.repeat(header.length));
console.log(header);
console.log('='.repeat(header.length));
console.log(`Data directory: ${dataDir}`);
const settings = await Settings.create(dataDir);
await settings.ensureStorageDirs();
const db = openDatabase(dataDir);
const dataServer = new DataServer(db);
const networks = new Networks(db, dataDir, dataServer, settings);
networks.init();

// Point the protocol layer at the live settings, then push the transfer rates
import { setUploadBroadcast, initUploadState } from './protocol/lish-protocol.ts';
import { applyNetworkLimits } from './protocol/network-limits.ts';
import { useNetworkSettings } from './settings.ts';
import { getUploadEnabledLishs, setUploadEnabled, getDownloadEnabledLishs, setDownloadEnabled } from './db/lishs.ts';
import { initDownloadState } from './api/transfer.ts';
useNetworkSettings(() => settings.get().network);
applyNetworkLimits(settings.get().network);
initUploadState(getUploadEnabledLishs(db), (lishID, enabled) => setUploadEnabled(db, lishID, enabled));
initDownloadState(getDownloadEnabledLishs(db), (lishID, enabled) => setDownloadEnabled(db, lishID, enabled));

const apiServer = new APIServer(dataDir, dataServer, networks, settings, {
	host: apiHost,
	port: apiPort,
	secure: apiSecure,
	keyFile: apiKeyFile,
	certFile: apiCertFile,
	apiToken,
});

// Wire upload progress broadcast (after apiServer is created)
setUploadBroadcast((event, data) => apiServer.broadcastEvent(event, data));

// Periodic internet connectivity check
import { startConnectivityCheck } from './connectivity.ts';
const stopConnectivityCheck = startConnectivityCheck((event, data) => apiServer.broadcastEvent(event, data));

// Memory profiling: JSONL log RSS/heap/internal sizes. MEMTRACE=0 disables.
// Diagnostic env vars use stable, un-branded names (set by the operator on a
// deployed node) so docker-compose and systemd units stay valid across rebrands.
if (process.env['MEMTRACE'] !== '0') {
	const intervalMs = Number(process.env['MEMTRACE_INTERVAL_MS'] ?? 30_000);
	const tracePath = process.env['MEMTRACE_FILE'] ?? join(dataDir, 'memory-trace.jsonl');
	startMemoryTrace({ filePath: tracePath, intervalMs, stdout: true });
}

// Heap snapshot on-demand: touch <dataDir>/trigger-heap OR kill -USR2 <pid>
if (process.env['HEAP_TRIGGER'] !== '0') startHeapSnapshotTrigger(dataDir);

let shuttingDown = false;
async function shutdown(): Promise<void> {
	if (shuttingDown) {
		// Second Ctrl+C → hard kill
		process.exit(1);
	}
	shuttingDown = true;
	console.log('Shutting down...');
	// Stop accepting new work (sync)
	stopConnectivityCheck();
	apiServer.stop();
	// Flush SQLite (bun:sqlite is synchronous, so all committed writes are already on disk —
	// close() finalizes any open statements and the WAL).
	try {
		db.close();
	} catch (err) {
		console.error('DB close error:', err);
	}
	// Give a short grace for any in-flight fs writes (download chunks, uploads) to drain.
	// We do NOT wait for libp2p node.stop() — peers get a TCP FIN from OS when the process exits.
	await new Promise(resolve => setTimeout(resolve, 200));
	process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

installRuntimeErrorHandlers();

await networks.startEnabledNetworks();
apiServer.start();
