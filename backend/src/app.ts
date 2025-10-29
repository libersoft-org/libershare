import { Network } from './network.ts';
import * as readline from 'readline';

	// Parse command line arguments
	const args = process.argv.slice(2);
	let dataDir = './data';
	let enablePink = false;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--datadir' && i + 1 < args.length) {
			dataDir = args[i + 1];
			i++;
		} else if (args[i] === '--pink') {
			enablePink = true;
		}
	}

	const network = new Network(dataDir, enablePink);

	// Set up readline interface for stdin
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: false
	});

	console.log('\nCommands: p=pink, c<multiaddr>=connect, f<peerid>=find, a=addresses, q=quit');

	rl.on('line', async (line) => {
		const command = line.trim();

		if (command.startsWith('c')) {
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
		} else {
			switch (command) {
				case 'p':
					await network.sendPing();
					//console.log('→ Pink sent');
					break;
				case 'a':
					network.printMultiaddrs();
					break;
				case 'q':
					console.log('Shutting down...');
					await network.stop();
					process.exit(0);
					break;
				default:
					console.log('Unknown command:', command);
			}
		}
	});

	// Keep the process running
	process.on('SIGINT', async () => {
		console.log('\nShutting down...');
		await network.stop();
		process.exit(0);
	});

	await network.start();
