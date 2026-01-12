import { setupLogger, type LogLevel } from './logger.ts';
import { Network } from './network.ts';
import { Downloader } from './downloader.ts';
import { DataServer } from './data-server.ts';
import { Database } from './database.ts';
import * as readline from 'readline';
import { join } from 'path';

// Parse command line arguments
const args = process.argv.slice(2);
let dataDir = './data';
let enablePink = false;
let logLevel: LogLevel = 'debug';

for (let i = 0; i < args.length; i++) {
	if (args[i] === '--datadir' && i + 1 < args.length) {
		dataDir = args[i + 1];
		i++;
	} else if (args[i] === '--pink') {
		enablePink = true;
	} else if (args[i] === '--loglevel' && i + 1 < args.length) {
		logLevel = args[i + 1] as LogLevel;
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

const network = new Network(dataDir, dataServer, enablePink);

async function shutdown() {
	console.log('Shutting down...');
	await network.stop();
	db.close();
	process.exit(0);
}

// Set up readline interface for stdin
const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
	terminal: false,
});

console.log('\nCommands: i<path>=import, l<path>=download, c<multiaddr>=connect, f<peerid>=find, a=addresses, p=pink, q=quit');

rl.on('line', async line => {
	const command = line.trim();

	if (command.startsWith('i')) {
		/*
		import a local file/directory as a dataset
		*/
		let inputPath = command.slice(1).trim();
		if (!inputPath) {
			/*console.log('Error: path required after "i"');
			return;*/
			inputPath = 'src'
		}
		try {
			console.log(`Importing: ${inputPath}`);
			const manifest = await dataServer.importDataset(inputPath, info => {
				if (info.type === 'chunk' && info.current && info.total) {
					console.log(`\r  Processing chunks: ${info.current}/${info.total}`);
				}
				else if (info.type === 'file' && info.path) {
					console.log(`\r  Processing file: ${info.path}                `);
				}
			});

			console.log(`✓ Import complete. Manifest ID: ${manifest.id}`);
		} catch (error: any) {
			console.log('✗ Import failed:', error.message);
		}

	} else if (command.startsWith('c')) {
		/*
		connect to peer by multiaddr
		 */
		const multiaddr = command.slice(1).trim();
		if (!multiaddr) {
			console.log('Error: multiaddr required after "c"');
			return;
		}
		try {
			await (network as any).connectToPeer(multiaddr);
		} catch (error: any) {
			console.log('✗ Connection failed:', error.message);
		}

	} else if (command.startsWith('f')) {
		/*
		find peer address by id
		 */
		const peerId = command.slice(1).trim();
		if (!peerId) {
			console.log('Error: peer ID required after "f"');
			return;
		}
		try {
			await (network as any).cliFindPeer(peerId);
		} catch (error: any) {
			console.log('✗ Find peer failed:', error.message);
		}

	} else if (command.startsWith('l')) {
		/*
		given lish file, start download
		*/
		let manifestPath = command.slice(1).trim();
		if (!manifestPath) {
			manifestPath = '../../lish_files/test.lish';
		}
		try {
			const downloadDir = join(dataDir, 'downloads', Date.now().toString());
			const downloader = new Downloader(downloadDir, network, dataServer);
			await downloader.init(manifestPath);
			await downloader.download();
		} catch (error: any) {
			console.log('✗ Download failed:', error.message);
		}
	} else {
		switch (command) {
			case 'p':
				await network.sendPink();
				//console.log('→ Pink sent');
				break;
			case 'a':
				network.printMultiaddrs();
				break;
			case 'q':
				await shutdown();
				break;
			default:
				console.log('Unknown command:', command);
		}
	}
});

process.on('SIGINT', shutdown);

await network.start();
