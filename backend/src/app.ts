import { dirname, join } from 'path';
import { pathToFileURL } from 'url';
import { productName, productVersion } from '@shared';
import { setupLogger, type LogLevel } from './logger.ts';
import { Networks } from './lishnet/lishnets.ts';
import { DataServer } from './lish/data-server.ts';
import { openDatabase } from './db/database.ts';
import { APIServer } from './api/api.ts';
import { Settings } from './settings.ts';
import { setWorkerUrl } from './lish/lish.ts';
import { startMemoryTrace } from './monitoring/memory-trace.ts';
import { startHeapSnapshotTrigger } from './monitoring/heap-snapshot.ts';

// Parse command line arguments
const args = process.argv.slice(2);
// Default dataDir: next to binary if compiled, otherwise ./data (relative to CWD)
const isCompiledBinary = process.execPath !== Bun.which('bun');
let dataDir = isCompiledBinary ? join(dirname(process.execPath), 'data') : './data';
if (isCompiledBinary) setWorkerUrl(pathToFileURL(join(dirname(process.execPath), 'lish', 'checksum-worker.js')).href);

let logLevel: LogLevel = isCompiledBinary ? 'info' : 'debug';
let apiHost = 'localhost';
let apiPort = 0;
let apiSecure = false;
let apiKeyFile: string | undefined;
let apiCertFile: string | undefined;
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
	} else if (args[i] === '--logfile' && i + 1 < args.length) {
		logFile = args[i + 1]!;
		i++;
	}
}

setupLogger(logLevel, logFile ?? join(dataDir, 'libershare.log'));
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

// Apply speed limits from settings
import { Downloader } from './protocol/downloader.ts';
import { setMaxUploadSpeed, setUploadBroadcast, initUploadState, setMaxUploadPeersPerLISH, setMaxMessageSize } from './protocol/lish-protocol.ts';
import { setMaxDownloadPeersPerLISH } from './protocol/peer-manager.ts';
import { getUploadEnabledLishs, setUploadEnabled, getDownloadEnabledLishs, setDownloadEnabled } from './db/lishs.ts';
import { initDownloadState } from './api/transfer.ts';
const networkSettings = settings.get().network;
Downloader.setMaxDownloadSpeed(networkSettings.maxDownloadSpeed);
setMaxUploadSpeed(networkSettings.maxUploadSpeed);
setMaxDownloadPeersPerLISH(networkSettings.maxDownloadPeersPerLISH);
setMaxUploadPeersPerLISH(networkSettings.maxUploadPeersPerLISH);
setMaxMessageSize(networkSettings.maxMessageSize);
initUploadState(getUploadEnabledLishs(db), (lishID, enabled) => setUploadEnabled(db, lishID, enabled));
initDownloadState(getDownloadEnabledLishs(db), (lishID, enabled) => setDownloadEnabled(db, lishID, enabled));

const apiServer = new APIServer(dataDir, dataServer, networks, settings, {
	host: apiHost,
	port: apiPort,
	secure: apiSecure,
	keyFile: apiKeyFile,
	certFile: apiCertFile,
});

// Wire upload progress broadcast (after apiServer is created)
setUploadBroadcast((event, data) => apiServer.broadcastEvent(event, data));

// Periodic internet connectivity check
import { startConnectivityCheck } from './connectivity.ts';
const stopConnectivityCheck = startConnectivityCheck((event, data) => apiServer.broadcastEvent(event, data));

// Memory profiling: JSONL log RSS/heap/internal sizes. LIBERSHARE_MEMTRACE=0 disables.
if (process.env['LIBERSHARE_MEMTRACE'] !== '0') {
	const intervalMs = Number(process.env['LIBERSHARE_MEMTRACE_INTERVAL_MS'] ?? 30_000);
	const tracePath = process.env['LIBERSHARE_MEMTRACE_FILE'] ?? join(dataDir, 'memory-trace.jsonl');
	startMemoryTrace({ filePath: tracePath, intervalMs, stdout: true });
}

// Heap snapshot on-demand: touch <dataDir>/trigger-heap OR kill -USR2 <pid>
if (process.env['LIBERSHARE_HEAP_TRIGGER'] !== '0') startHeapSnapshotTrigger(dataDir);

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

// Transient libp2p errors that can occur during normal peer churn, stream
// timeouts, connection drops, etc. These must not crash the process.
const TRANSIENT_ERRORS = new Set([
	// Stream errors (@libp2p/interface)
	'StreamStateError',
	'StreamResetError',
	'StreamAbortedError',
	'StreamBufferError',
	'StreamClosedError',
	// Connection errors (@libp2p/interface, libp2p core)
	'ConnectionClosedError',
	'ConnectionClosingError',
	'ConnectionFailedError',
	'ConnectionDeniedError',
	'ConnectionInterceptedError',
	// Muxer errors (@libp2p/interface, @chainsafe/libp2p-yamux)
	'MuxerClosedError',
	'MuxerUnavailableError',
	'InvalidFrameError',
	'ReceiveWindowExceededError',
	'InvalidStateError',
	'StreamAlreadyExistsError',
	'BothClientsError',
	// Dial errors (libp2p core)
	'DialError',
	'DialDeniedError',
	'NoValidAddressesError',
	'TransportUnavailableError',
	// Timeout & abort
	'AbortError',
	'TimeoutError',
	// Crypto / handshake (noise, relay)
	'EncryptionFailedError',
	'InvalidCryptoExchangeError',
	// Protocol / message errors from misbehaving peers
	'ProtocolError',
	'InvalidMessageError',
	'UnsupportedProtocolError',
	'UnexpectedPeerError',
	'UnexpectedEOFError',
	'InvalidMessageLengthError',
	'InvalidDataLengthError',
	// Resource limits
	'TooManyInboundProtocolStreamsError',
	'TooManyOutboundProtocolStreamsError',
	'QueueFullError',
	'RateLimitError',
	'LimitedConnectionError',
	// Relay limits (@libp2p/circuit-relay-v2)
	'TransferLimitError',
	'DurationLimitError',
	'RelayQueueFullError',
	'HadEnoughRelaysError',
	'DoubleRelayError',
]);

function isTransientError(err: any): boolean {
	const name = err?.constructor?.name || err?.name || '';
	if (TRANSIENT_ERRORS.has(name)) return true;
	// Node EventEmitter wraps stream 'error' events with no listener as
	// `Error: Unhandled error.` libp2p stream/muxer paths emit DOMException
	// TimeoutError / AbortError on the underlying socket when a peer goes silent
	// and no listener is attached. Both forms are transient.
	const msg: string = err?.message ?? '';
	const ctxMsg: string = err?.context?.message ?? '';
	if (msg.startsWith('Unhandled error.') && /TimeoutError|AbortError|ECONNRESET|EPIPE/i.test(msg)) return true;
	if (msg.includes('Unhandled error') && (ctxMsg.includes('timed out') || ctxMsg.includes('aborted') || ctxMsg.includes('closed') || ctxMsg.includes('reset'))) return true;
	// Cause-chain check (Node may set .cause on wrapped errors).
	const causeName = err?.cause?.constructor?.name || err?.cause?.name || '';
	if (causeName === 'TimeoutError' || causeName === 'AbortError') return true;
	return false;
}

// Rate-limiter for the highest-frequency transient error coming from gossipsub
// internals (StreamStateError: "Cannot write to a stream that is closed").
// This is a known issue in @chainsafe/libp2p-gossipsub where sendRpc does not
// catch sync throws from rawStream.send() on closed streams. Logging each one
// produces ~5000 warn/hour of pure noise. We keep an occasional summary so the
// condition is still observable.
const transientLogState = new Map<string, { count: number; lastLogAt: number }>();
const TRANSIENT_LOG_INTERVAL_MS = 60_000;
function logTransientRateLimited(kind: 'error' | 'rejection', name: string, message: string): void {
	const key = `${kind}:${name}`;
	const state = transientLogState.get(key) ?? { count: 0, lastLogAt: 0 };
	state.count++;
	const now = Date.now();
	if (now - state.lastLogAt >= TRANSIENT_LOG_INTERVAL_MS) {
		const suppressed = state.count > 1 ? ` (×${state.count} in last ${Math.round((now - state.lastLogAt) / 1000)}s)` : '';
		console.warn(`[WARN] Suppressed transient libp2p ${kind} (${name})${suppressed}: ${message}`);
		state.count = 0;
		state.lastLogAt = now;
	}
	transientLogState.set(key, state);
}

process.on('uncaughtException', err => {
	if (isTransientError(err)) {
		const name = (err as any)?.constructor?.name || err.name || '';
		logTransientRateLimited('error', name, err.message);
		return;
	}
	const ctorName = (err as any)?.constructor?.name || '';
	const errName = (err as any)?.name || '';
	const errMessage = (err as any)?.message || '';
	const errStack = (err as any)?.stack || '';
	const errKeys = err && typeof err === 'object' ? Object.keys(err as any).join(',') : '';
	console.error(`[FATAL] Uncaught exception: ctor=${ctorName} name=${errName} msg=${errMessage} keys=${errKeys}`);
	console.error('[FATAL] stack:', errStack);
	console.error('[FATAL] full:', JSON.stringify(err, Object.getOwnPropertyNames(err as any)));
	process.exit(1);
});

process.on('unhandledRejection', (reason: any) => {
	if (isTransientError(reason)) {
		const name = reason?.constructor?.name || reason?.name || '';
		logTransientRateLimited('rejection', name, reason?.message ?? '');
		return;
	}
	const ctorName = reason?.constructor?.name || '';
	const errName = reason?.name || '';
	const errMessage = reason?.message || '';
	const errStack = reason?.stack || '';
	const errKeys = reason && typeof reason === 'object' ? Object.keys(reason).join(',') : '';
	console.error(`[FATAL] Unhandled rejection: ctor=${ctorName} name=${errName} msg=${errMessage} keys=${errKeys}`);
	console.error('[FATAL] stack:', errStack);
	console.error('[FATAL] full:', JSON.stringify(reason, Object.getOwnPropertyNames(reason)));
	process.exit(1);
});

await networks.startEnabledNetworks();
apiServer.start();
