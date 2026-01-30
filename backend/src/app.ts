import { setupLogger, type LogLevel } from './logger.ts';
import { Networks } from './networks.ts';
import { Downloader } from './downloader.ts';
import { DataServer } from './data-server.ts';
import { Database } from './database.ts';
import { ApiServer } from './api.ts';
import * as readline from 'readline';
import { join } from 'path';

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

const file = Bun.file(dataDir + '/settings.json');
if (!(await file.exists())) {
	let settings = {
		network: {
			port: 9090,
			bootstrapPeers: [],
		},
		relay: {
			server: {
				enabled: true,
			},
		},
	};
	await file.write(JSON.stringify(settings, null, 1));
}

const db = new Database(dataDir);
await db.init();

const dataServer = new DataServer(dataDir, db);
await dataServer.init();

const networks = new Networks(db.getDb(), dataDir, dataServer, enablePink);
networks.init();

const apiServer = new ApiServer(dataDir, db, dataServer, networks, {
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

// Helper to get first live network for CLI commands
function getFirstNetwork() {
	const liveNetworks = networks.getLiveNetworks();
	if (liveNetworks.size === 0) {
		console.log('No networks running');
		return null;
	}
	return liveNetworks.values().next().value;
}

process.on('SIGINT', shutdown);

await networks.startEnabledNetworks();
apiServer.start();
