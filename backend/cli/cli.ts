#!/usr/bin/env bun
import * as readline from 'readline';
import { ApiClient } from './api-client';
import { Api } from '@libershare/shared';

const DEFAULT_URL = 'ws://localhost:1158';

const HELP = `
Commands:
  networks.list                     List all networks
  networks.import <path>            Import network from file
  networks.connect <multiaddr>      Connect to a peer
  networks.findPeer <peerId>        Find peer by ID
  networks.info                     Show node info (peer ID, addresses)
  datasets.list                     List all datasets
  datasets.import <path>            Import file/directory as dataset
  download <manifestPath>           Download from .lish file
  stats                             Show stats
  quit                              Exit
`;

const args = process.argv.slice(2);
let serverUrl = DEFAULT_URL;

for (let i = 0; i < args.length; i++) {
	if ((args[i] === '--url' || args[i] === '-u') && i + 1 < args.length) {
		serverUrl = args[i + 1];
		i++;
	} else if (args[i] === '--help' || args[i] === '-h') {
		console.log(`
libershare CLI - Connect to a running libershare server

Usage: bun cli.ts [options]

Options:
  -u, --url <url>   Server WebSocket URL (default: ${DEFAULT_URL})
  -h, --help        Show this help message
${HELP}`);
		process.exit(0);
	}
}

async function main() {
	console.log(`Connecting to ${serverUrl}...`);

	const client = new ApiClient(serverUrl);
	try {
		await client.connect();
	} catch (error: any) {
		console.error(`Failed to connect: ${error.message}`);
		process.exit(1);
	}

	console.log('Connected!\n');

	const api = new Api(client);

	async function getFirstNetworkId(): Promise<string | null> {
		const networks = await api.networks.list();
		const enabled = networks.filter(n => n.enabled);
		if (enabled.length === 0) {
			console.log('No enabled networks');
			return null;
		}
		return enabled[0].id;
	}

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: true,
	});

	console.log('Type "help" for commands\n');

	rl.on('line', async line => {
		const parts = line.trim().split(/\s+/);
		const command = parts[0];
		const arg = parts.slice(1).join(' ');

		if (!command) return;

		try {
			switch (command) {
				case 'networks.list': {
					const networks = await api.networks.list();
					console.log('Networks:');
					if (networks.length === 0) {
						console.log('  (none)');
					} else {
						networks.forEach(n => {
							const status = n.enabled ? '✓' : '✗';
							console.log(`  ${status} ${n.name} (${n.id})`);
						});
					}
					break;
				}

				case 'networks.import': {
					if (!arg) {
						console.log('Usage: networks.import <path>');
						break;
					}
					console.log(`Importing network from: ${arg}`);
					const network = await api.networks.importFromFile(arg, true);
					console.log(`✓ Network imported: ${network.name} (${network.id})`);
					break;
				}

				case 'networks.connect': {
					if (!arg) {
						console.log('Usage: networks.connect <multiaddr>');
						break;
					}
					const networkId = await getFirstNetworkId();
					if (!networkId) break;
					await api.networks.connect(networkId, arg);
					console.log('✓ Connected');
					break;
				}

				case 'networks.findPeer': {
					if (!arg) {
						console.log('Usage: networks.findPeer <peerId>');
						break;
					}
					const networkId = await getFirstNetworkId();
					if (!networkId) break;
					const result = await api.networks.findPeer(networkId, arg);
					console.log('Peer info:', result);
					break;
				}

				case 'networks.info': {
					const networkId = await getFirstNetworkId();
					if (!networkId) break;
					const info = await api.networks.getNodeInfo(networkId);
					console.log(`Peer ID: ${info.peerId}`);
					console.log('Addresses:');
					info.addresses.forEach(addr => console.log(`  ${addr}`));
					break;
				}

				case 'datasets.list': {
					const datasets = await api.datasets.list();
					console.log('Datasets:');
					if (datasets.length === 0) {
						console.log('  (none)');
					} else {
						datasets.forEach(d => {
							const status = d.complete ? '✓' : '⋯';
							console.log(`  ${status} ${d.manifestId} (${d.directory})`);
						});
					}
					break;
				}

				case 'datasets.import': {
					if (!arg) {
						console.log('Usage: datasets.import <path>');
						break;
					}
					console.log(`Importing: ${arg}`);
					const result = await api.createLish(arg);
					console.log(`✓ Import complete. Manifest ID: ${result.manifestId}`);
					break;
				}

				case 'download': {
					if (!arg) {
						console.log('Usage: download <manifestPath>');
						break;
					}
					const networkId = await getFirstNetworkId();
					if (!networkId) break;
					console.log(`Downloading: ${arg}`);
					const result = await api.download(networkId, arg);
					console.log(`✓ Download started. Directory: ${result.downloadDir}`);
					break;
				}

				case 'stats': {
					const stats = await api.getStats();
					console.log('Stats:', JSON.stringify(stats, null, 2));
					break;
				}

				case 'help':
				case 'h':
				case '?':
					console.log(HELP);
					break;

				case 'quit':
				case 'exit':
				case 'q':
					console.log('Bye!');
					client.close();
					rl.close();
					process.exit(0);

				default:
					console.log(`Unknown command: ${command}. Type "help" for commands.`);
			}
		} catch (error: any) {
			console.log(`✗ Error: ${error.message}`);
		}
	});

	rl.on('close', () => {
		client.close();
		process.exit(0);
	});
}

main().catch(err => {
	console.error('Fatal error:', err);
	process.exit(1);
});
