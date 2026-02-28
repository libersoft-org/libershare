#!/usr/bin/env bun
import * as readline from 'readline';
import { join } from 'path';
import { APIClient } from './api-client';
import { API } from '@shared';

const DEFAULT_URL = 'ws://localhost:1158';

const HELP = `
Commands:
  lishnets.list                      List all networks
  lishnets.get <id>                  Get network details
  lishnets.import <path>             Import network from file
  lishnets.enable <id>               Enable a network
  lishnets.disable <id>              Disable a network
  lishnets.delete <id>               Delete a network
  lishnets.connect <multiaddr>       Connect to a peer
  lishnets.findPeer <peerID>         Find peer by ID
  lishnets.infoAll                   Show all networks with config and runtime info
  lishnets.status                    Show network status
  lishnets.peers                     List connected peers
  lishnets.addresses                 List node addresses
  lishnets.nodeInfo                  Show node info (peer ID, addresses)

  lishs.list                       List all LISHs
  lishs.get <id>                   Get LISH details

  datasets.list                     List all datasets
  datasets.get <id>                 Get dataset details
  datasets.import <path>            Import file/directory as dataset

  fs.info                           Show filesystem info
  fs.list [path]                    List directory contents
  fs.read <path>                    Read file contents
  fs.mkdir <path>                   Create directory
  fs.delete <path>                  Delete file or directory

  download <lishPath>              Download from .lish file
  fetch <url>                       Fetch URL content
  help                              Show this help
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
CLI - Connect to a running server

Usage: bun cli.ts [options]

Options:
  -u, --url <url>   Server WebSocket URL (default: ${DEFAULT_URL})
  -h, --help        Show this help message
${HELP}`);
		process.exit(0);
	}
}

function expandHome(p: string): string {
	if (p.startsWith('~')) return p.replace('~', process.env.HOME || '/');
	return p;
}

function resolvePath(x: string): string {
	x = expandHome(x);
	if (!x.startsWith('/')) x = join(process.cwd(), x);
	return x;
}

async function main(): Promise<void> {
	console.log(`Connecting to ${serverUrl}...`);
	const client = new APIClient(serverUrl);
	try {
		await client.connect();
	} catch (error: any) {
		console.error(`Failed to connect: ${error.message}`);
		process.exit(1);
	}
	console.log('Connected!\n');
	const api = new API(client);

	async function getFirstNetworkID(): Promise<string | null> {
		const networks = await api.lishnets.list();
		const enabled = networks.filter(n => n.enabled);
		if (enabled.length === 0) {
			console.log('No enabled networks');
			return null;
		}
		return enabled[0].networkID;
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
				// ============ Networks ============
				case 'lishnets.list': {
					const networks = await api.lishnets.list();
					console.log('Networks:');
					if (networks.length === 0) {
						console.log('  (none)');
					} else {
						networks.forEach(n => {
							const status = n.enabled ? '✓' : '✗';
							console.log(`  ${status} ${n.name} (${n.networkID})`);
						});
					}
					break;
				}

				case 'lishnets.get': {
					if (!arg) {
						console.log('Usage: lishnets.get <id>');
						break;
					}
					const network = await api.lishnets.get(arg);
					console.log(JSON.stringify(network, null, 2));
					break;
				}

				case 'lishnets.import': {
					if (!arg) {
						console.log('Usage: lishnets.import <path>');
						break;
					}
					console.log(`Importing network from: ${arg}`);
					const network = await api.lishnets.importFromFile(arg, true);
					console.log(`✓ Network imported: ${network.name} (${network.networkID})`);
					break;
				}

				case 'lishnets.enable': {
					if (!arg) {
						console.log('Usage: lishnets.enable <id>');
						break;
					}
					await api.lishnets.setEnabled(arg, true);
					console.log(`✓ Network enabled`);
					break;
				}

				case 'lishnets.disable': {
					if (!arg) {
						console.log('Usage: lishnets.disable <id>');
						break;
					}
					await api.lishnets.setEnabled(arg, false);
					console.log(`✓ Network disabled`);
					break;
				}

				case 'lishnets.delete': {
					if (!arg) {
						console.log('Usage: lishnets.delete <id>');
						break;
					}
					await api.lishnets.delete(arg);
					console.log(`✓ Network deleted`);
					break;
				}

				case 'lishnets.connect': {
					if (!arg) {
						console.log('Usage: lishnets.connect <multiaddr>');
						break;
					}
					const networkID = await getFirstNetworkID();
					if (!networkID) break;
					await api.lishnets.connect(networkID, arg);
					console.log('✓ Connected');
					break;
				}

				case 'lishnets.findPeer': {
					if (!arg) {
						console.log('Usage: lishnets.findPeer <peerID>');
						break;
					}
					const networkID = await getFirstNetworkID();
					if (!networkID) break;
					const result = await api.lishnets.findPeer(networkID, arg);
					console.log('Peer info:', JSON.stringify(result, null, 2));
					break;
				}

				case 'lishnets.infoAll': {
					const infos = await api.lishnets.infoAll();
					if (infos.length === 0) {
						console.log('No networks');
						break;
					}
					for (const info of infos) {
						const status = info.enabled ? '✓' : '✗';
						console.log(`${status} ${info.name} (${info.networkID})`);
						console.log(`    version: ${info.version}`);
						if (info.description) console.log(`    description: ${info.description}`);
						console.log(`    bootstrapPeers: ${info.bootstrapPeers.length}`);
						if (info.enabled && info.peerID) {
							console.log(`    peerID: ${info.peerID}`);
							console.log(`    addresses: ${info.addresses?.length || 0}`);
							info.addresses?.forEach(a => console.log(`      ${a}`));
							console.log(`    connected: ${info.connected || 0}`);
							if (info.connectedPeers && info.connectedPeers.length > 0) {
								info.connectedPeers.forEach(p => console.log(`      ${p}`));
							}
							console.log(`    peersInStore: ${info.peersInStore || 0}`);
						}
						console.log('');
					}
					break;
				}

				case 'lishnets.nodeInfo': {
					const info = await api.lishnets.getNodeInfo();
					console.log(`Peer ID: ${info.peerID}`);
					console.log('Addresses:');
					info.addresses.forEach(addr => console.log(`  ${addr}`));
					break;
				}

				case 'lishnets.status': {
					const networkID = await getFirstNetworkID();
					if (!networkID) break;
					const status = await api.lishnets.getStatus(networkID);
					console.log(`Connected peers: ${status.connected}`);
					console.log(`Peers in store: ${status.peersInStore}`);
					console.log(`Datasets: ${status.datasets}`);
					if (status.connectedPeers.length > 0) {
						console.log('Connected:');
						status.connectedPeers.forEach(p => console.log(`  ${p}`));
					}
					break;
				}

				case 'lishnets.peers': {
					const networkID = await getFirstNetworkID();
					if (!networkID) break;
					const peers = await api.lishnets.getPeers(networkID);
					console.log('Peers:');
					if (peers.length === 0) {
						console.log('  (none)');
					} else {
						peers.forEach(p => console.log(`  ${p}`));
					}
					break;
				}

				case 'lishnets.addresses': {
					const networkID = await getFirstNetworkID();
					if (!networkID) break;
					const addresses = await api.lishnets.getAddresses(networkID);
					console.log('Addresses:');
					if (addresses.length === 0) {
						console.log('  (none)');
					} else {
						addresses.forEach(a => console.log(`  ${a}`));
					}
					break;
				}

				// ============ LISHs ============
				case 'lishs.list': {
					const lishs = await api.lishs.list();
					console.log('LISHs:');
					if (lishs.length === 0) {
						console.log('  (none)');
					} else {
						lishs.forEach(m => console.log(`  ${m.id}`));
					}
					break;
				}

				case 'lishs.get': {
					if (!arg) {
						console.log('Usage: lishs.get <id>');
						break;
					}
					const lish = await api.lishs.get(arg);
					console.log(JSON.stringify(lish, null, 2));
					break;
				}

				// ============ Datasets ============
				case 'datasets.list': {
					const datasets = await api.datasets.list();
					console.log('Datasets:');
					if (datasets.length === 0) {
						console.log('  (none)');
					} else {
						datasets.forEach(d => {
							const status = d.complete ? '✓' : '⋯';
							console.log(`  ${status} ${d.lishID} (${d.directory})`);
						});
					}
					break;
				}

				case 'datasets.get': {
					if (!arg) {
						console.log('Usage: datasets.get <id>');
						break;
					}
					const dataset = await api.datasets.get(arg);
					console.log(JSON.stringify(dataset, null, 2));
					break;
				}

				case 'datasets.import': {
					if (!arg) {
						console.log('Usage: datasets.import <path>');
						break;
					}
					const resolvedArg = resolvePath(arg);
					console.log(`Importing: ${resolvedArg}`);
					const result = await api.lishs.create(resolvedArg);
					console.log(`✓ Import complete. LISH ID: ${result.lishID}`);
					break;
				}

				// ============ Filesystem ============
				case 'fs.info': {
					const info = await api.fs.info();
					console.log(`Platform: ${info.platform}`);
					console.log(`Separator: ${info.separator}`);
					console.log(`Home: ${info.home}`);
					console.log('Roots:');
					info.roots.forEach(r => console.log(`  ${r}`));
					break;
				}

				case 'fs.list': {
					const result = await api.fs.list(arg || undefined);
					console.log(`Path: ${result.path}`);
					console.log('Entries:');
					if (result.entries.length === 0) {
						console.log('  (empty)');
					} else {
						result.entries.forEach(e => {
							const icon = e.type === 'directory' ? '📁' : e.type === 'drive' ? '💾' : '📄';
							const size = e.size !== undefined ? ` (${e.size})` : '';
							console.log(`  ${icon} ${e.name}${size}`);
						});
					}
					break;
				}

				case 'fs.read': {
					if (!arg) {
						console.log('Usage: fs.read <path>');
						break;
					}
					const content = await api.fs.readText(arg);
					console.log(content);
					break;
				}

				case 'fs.mkdir': {
					if (!arg) {
						console.log('Usage: fs.mkdir <path>');
						break;
					}
					await api.fs.mkdir(arg);
					console.log(`✓ Directory created`);
					break;
				}

				case 'fs.delete': {
					if (!arg) {
						console.log('Usage: fs.delete <path>');
						break;
					}
					await api.fs.delete(arg);
					console.log(`✓ Deleted`);
					break;
				}

				// ============ Top-level ============
				case 'download': {
					if (!arg) {
						console.log('Usage: download <lishPath>');
						break;
					}
					const networkID = await getFirstNetworkID();
					if (!networkID) break;
					console.log(`Downloading: ${arg}`);
					const result = await api.transfer.download(networkID, arg);
					console.log(`✓ Download started. Directory: ${result.downloadDir}`);
					break;
				}

				case 'fetch': {
					if (!arg) {
						console.log('Usage: fetch <url>');
						break;
					}
					const result = await api.fetchUrl(arg);
					console.log(`Status: ${result.status}`);
					console.log(`Content-Type: ${result.contentType}`);
					console.log('---');
					console.log(result.content);
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
