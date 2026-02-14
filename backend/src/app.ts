import { setupLogger, type LogLevel } from './logger.ts';
import { Networks } from './networks.ts';
import { DataServer } from './data-server.ts';
import { Database } from './database.ts';
import { ApiServer } from './api.ts';
import { LISHNetworkStorage } from './lishNetworkStorage.ts';

// Parse command line arguments
const args = process.argv.slice(2);
let dataDir = './data';
let enablePink = false;
let logLevel: LogLevel = 'debug';
let apiHost = 'localhost';
let apiPort = 1158;
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
const db = new Database(dataDir);
await db.init();
const dataServer = new DataServer(dataDir, db);
await dataServer.init();
const lishNetworkStorage = new LISHNetworkStorage(dataDir);
const networks = new Networks(lishNetworkStorage, dataDir, dataServer, enablePink);
networks.init();

const apiServer = new ApiServer(dataDir, db, dataServer, networks, lishNetworkStorage, {
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
	db.close();
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

// Prevent crash on transient libp2p stream errors (e.g. gossipsub race condition
// where a peer disconnects before subscriptions are sent on the outbound stream).
process.on('uncaughtException', err => {
	const name = (err as any)?.constructor?.name || err.name || '';
	if (name === 'StreamStateError' || name === 'ConnectionClosedError' || name === 'StreamResetError') {
		console.warn(`[WARN] Suppressed transient libp2p error (${name}): ${err.message}`);
		return;
	}
	console.error('[FATAL] Uncaught exception:', err);
	process.exit(1);
});

process.on('unhandledRejection', (reason: any) => {
	const name = reason?.constructor?.name || reason?.name || '';
	if (name === 'StreamStateError' || name === 'ConnectionClosedError' || name === 'StreamResetError') {
		console.warn(`[WARN] Suppressed transient libp2p rejection (${name}): ${reason.message}`);
		return;
	}
	console.error('[FATAL] Unhandled rejection:', reason);
	process.exit(1);
});

await networks.startEnabledNetworks();
apiServer.start();
