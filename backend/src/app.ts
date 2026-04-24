import { dirname, join } from 'path';
import { productName, productVersion } from '@shared';
import { setupLogger, type LogLevel } from './logger.ts';
import { Networks } from './lishnet/lishnets.ts';
import { DataServer } from './lish/data-server.ts';
import { openDatabase } from './db/database.ts';
import { APIServer } from './api/api.ts';
import { Settings } from './settings.ts';
import { setWorkerUrl } from './lish/lish.ts';

// Parse command line arguments
const args = process.argv.slice(2);
// Default dataDir: next to binary if compiled, otherwise ./data (relative to CWD)
const isCompiledBinary = process.execPath !== Bun.which('bun');
let dataDir = isCompiledBinary ? join(dirname(process.execPath), 'data') : './data';

// In compiled binaries, import.meta.url is always the binary path (/$bunfs/root/<binary>),
// so the worker is at ./lish/checksum-worker.js relative to it.
// In dev mode the default in lish.ts (./checksum-worker.ts relative to lish.ts) is correct.
if (isCompiledBinary) setWorkerUrl(new URL('./lish/checksum-worker.js', import.meta.url).href);

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
import { setMaxUploadSpeed, setUploadBroadcast, initUploadState, setMaxUploadPeersPerLISH } from './protocol/lish-protocol.ts';
import { setMaxDownloadPeersPerLISH } from './protocol/peer-manager.ts';
import { getUploadEnabledLishs, setUploadEnabled, getDownloadEnabledLishs, setDownloadEnabled } from './db/lishs.ts';
import { initDownloadState } from './api/transfer.ts';
const networkSettings = settings.get().network;
Downloader.setMaxDownloadSpeed(networkSettings.maxDownloadSpeed);
setMaxUploadSpeed(networkSettings.maxUploadSpeed);
setMaxDownloadPeersPerLISH(networkSettings.maxDownloadPeersPerLISH);
setMaxUploadPeersPerLISH(networkSettings.maxUploadPeersPerLISH);
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
	// Node EventEmitter wraps stream 'error' events with no listener as `Error: Unhandled error. (...)`.
	// libp2p stream/muxer paths emit DOMException TimeoutError / AbortError on the underlying socket
	// when a peer goes silent, and there's no listener attached. Treat as transient.
	const msg: string = err?.message || '';
	if (msg.startsWith('Unhandled error.') && /TimeoutError|AbortError|ECONNRESET|EPIPE/i.test(msg)) return true;
	// Cause-chain check (Node may set .cause on wrapped errors)
	const causeName = err?.cause?.constructor?.name || err?.cause?.name || '';
	if (causeName === 'TimeoutError' || causeName === 'AbortError') return true;
	return false;
}

process.on('uncaughtException', err => {
	if (isTransientError(err)) {
		const name = (err as any)?.constructor?.name || err.name || '';
		console.warn(`[WARN] Suppressed transient libp2p error (${name}): ${err.message}`);
		return;
	}
	console.error('[FATAL] Uncaught exception:', err);
	process.exit(1);
});

process.on('unhandledRejection', (reason: any) => {
	if (isTransientError(reason)) {
		const name = reason?.constructor?.name || reason?.name || '';
		console.warn(`[WARN] Suppressed transient libp2p rejection (${name}): ${reason?.message}`);
		return;
	}
	console.error('[FATAL] Unhandled rejection:', reason);
	process.exit(1);
});

await networks.startEnabledNetworks();
apiServer.start();
