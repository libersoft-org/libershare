import { dirname, join } from 'path';
import { productName, productVersion } from '@shared';
import { setupLogger, type LogLevel } from './logger.ts';
import { Networks } from './lishnet/networks.ts';
import { DataServer } from './lish/data-server.ts';
import { ApiServer } from './api/server.ts';
import { LISHNetworkStorage } from './lishnet/lishNetworkStorage.ts';
import { Settings } from './settings.ts';

// Parse command line arguments
const args = process.argv.slice(2);
// Default dataDir: next to binary if compiled, otherwise ./data (relative to CWD)
const isCompiledBinary = process.execPath !== Bun.which('bun');
let dataDir = isCompiledBinary ? join(dirname(process.execPath), 'data') : './data';
let enablePink = false;
let logLevel: LogLevel = 'debug';
let apiHost = 'localhost';
let apiPort = 0;
let apiSecure = false;
let apiKeyFile: string | undefined;
let apiCertFile: string | undefined;

for (let i = 0; i < args.length; i++) {
	if (args[i] === '--datadir' && i + 1 < args.length) {
		dataDir = args[i + 1];
		i++;
	} else if (args[i] === '--pink') {
		enablePink = true;
	} else if (args[i] === '--loglevel' && i + 1 < args.length) {
		logLevel = args[i + 1] as LogLevel;
		i++;
	} else if (args[i] === '--host' && i + 1 < args.length) {
		apiHost = args[i + 1];
		i++;
	} else if (args[i] === '--port' && i + 1 < args.length) {
		apiPort = parseInt(args[i + 1], 10);
		i++;
	} else if (args[i] === '--secure') {
		apiSecure = true;
	} else if (args[i] === '--privkey' && i + 1 < args.length) {
		apiKeyFile = args[i + 1];
		i++;
	} else if (args[i] === '--pubkey' && i + 1 < args.length) {
		apiCertFile = args[i + 1];
		i++;
	}
}

setupLogger(logLevel);
const header = `${productName} v${productVersion}`;
console.log('='.repeat(header.length));
console.log(header);
console.log('='.repeat(header.length));
console.log(`Data directory: ${dataDir}`);
const settings = new Settings(dataDir);
await settings.ensureStorageDirs();
const dataServer = new DataServer(dataDir);
const lishNetworkStorage = new LISHNetworkStorage(dataDir);
const networks = new Networks(lishNetworkStorage, dataDir, dataServer, enablePink);
networks.init();

const apiServer = new ApiServer(dataDir, dataServer, networks, lishNetworkStorage, {
	host: apiHost,
	port: apiPort,
	secure: apiSecure,
	keyFile: apiKeyFile,
	certFile: apiCertFile,
});

async function shutdown() {
	console.log('Shutting down...');
	apiServer.stop();
	await networks.stopAllNetworks();
	process.exit(0);
}

// Helper to get the shared network instance for CLI commands
function getNetwork() {
	const network = networks.getNetwork();
	if (!network.isRunning()) {
		console.log('Network not running');
		return null;
	}
	return network;
}

process.on('SIGINT', shutdown);

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
	return TRANSIENT_ERRORS.has(name);
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
