import { formatBytes, type ILISHNetwork } from '@shared';
interface IArgs {
	name?: string;
	description?: string;
	bootstrap?: string[];
	output?: string;
}

function showHelp(): void {
	console.log('Usage: ./makenet.sh --name <network-name> --bootstrap <multiaddr> [options]');
	console.log('');
	console.log('Options:');
	console.log('  --name <text>            Network name (required)');
	console.log('  --bootstrap <multiaddr>  Bootstrap peer multiaddr (required, can be specified multiple times)');
	console.log('  --description <text>     Description for the network (optional)');
	console.log('  --output <path>          Output network file (optional, default: [NAME].lishnet)');
	console.log('                           Supports placeholders: [UUID], [NAME]');
	console.log('                           [UUID] will be replaced with network UUID');
	console.log('                           [NAME] will be replaced with network name');
	console.log('  --help                   Show this help message');
	console.log('');
	console.log('Multiaddr format examples:');
	console.log('  /ip4/192.168.0.10/tcp/9090/p2p/QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N');
	console.log('  /dns4/bootstrap.example.com/tcp/7070/p2p/QmU3vQnXwYp7zRfKjLmN9BcDeTpRsWxYvZqNmLkJhGfTxP');
	console.log('  /ip6/fd00::1/tcp/5050/p2p/QmV9wRyYzP8bNcMjDkLqTnWsXvZpRmLkJhGfTxPuOnXwYq');
	console.log('');
	console.log('Examples:');
	console.log('  ./makenet.sh --name "Open source network" --bootstrap "/ip4/192.168.0.10/tcp/9090/p2p/Qm..."');
	console.log('  ./makenet.sh --name "Research network" --bootstrap "/ip4/192.168.0.10/tcp/9090/p2p/Qm..." --bootstrap "/ip4/192.168.0.11/tcp/7070/p2p/Qm..." --description "Private research network"');
	console.log('  ./makenet.sh --name "Lab network" --bootstrap "/dns4/bootstrap.example.com/tcp/9090/p2p/Qm..." --bootstrap "/ip4/192.168.0.10/tcp/9090/p2p/Qm..." --output [UUID].lishnet');
}

function parseArgs(args: string[]): IArgs {
	const parsed: IArgs = {
		bootstrap: [],
	};
	const argMap: Record<string, keyof IArgs> = {
		'--name': 'name',
		'--description': 'description',
		'--output': 'output',
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		const key = argMap[arg];
		if (key && i + 1 < args.length) (parsed as any)[key] = args[++i];
		else if (arg === '--bootstrap' && i + 1 < args.length) parsed.bootstrap!.push(args[++i]!);
	}
	return parsed;
}

function validateMultiaddr(multiaddr: string): boolean {
	// Basic validation - should start with / and contain required components
	if (!multiaddr.startsWith('/')) return false;
	const parts = multiaddr.split('/').filter(p => p.length > 0);
	if (parts.length < 6) return false; // e.g., ip4, address, tcp, port, p2p, peerid
	// Check for required protocol components
	const hasTransport = parts.includes('ip4') || parts.includes('ip6') || parts.includes('dns4') || parts.includes('dns6');
	const hasTcp = parts.includes('tcp') || parts.includes('udp');
	const hasP2p = parts.includes('p2p');
	return hasTransport && hasTcp && hasP2p;
}

async function main(): Promise<void> {
	console.log('');
	console.log('=========================');
	console.log('LISH network file creator');
	console.log('=========================');
	console.log('');
	const args = parseArgs(Bun.argv.slice(2));
	if (Bun.argv.includes('--help')) {
		showHelp();
		process.exit(0);
	}
	if (!args.name) {
		showHelp();
		console.log();
		console.error('Error: --name parameter is required');
		process.exit(1);
	}
	if (!args.bootstrap || args.bootstrap.length === 0) {
		showHelp();
		console.log();
		console.error('Error: At least one --bootstrap parameter is required');
		process.exit(1);
	}
	// Validate bootstrap peers
	for (const peer of args.bootstrap) {
		if (!validateMultiaddr(peer)) {
			console.error('Error: Invalid multiaddr format: ' + peer);
			console.error('Expected format: /ip4/<address>/tcp/<port>/p2p/<peerID>');
			console.error('See --help for examples');
			process.exit(1);
		}
	}
	const name = args.name;
	const defaultOutput = '[NAME].lishnet';
	const outputTemplate = args.output || defaultOutput;
	const networkID = globalThis.crypto.randomUUID();
	const outputFile = outputTemplate.replace(/\[UUID\]/g, networkID).replace(/\[NAME\]/g, name);
	if (outputTemplate.includes('[NAME]') && !name) {
		console.error('Error: --output contains [NAME] placeholder but --name parameter is not provided');
		process.exit(1);
	}
	try {
		const network: ILISHNetwork = {
			networkID: networkID,
			name: name,
			bootstrapPeers: args.bootstrap,
			created: new Date().toISOString(),
		};
		if (args.description) network.description = args.description;
		const startTime = Date.now();
		console.log('\x1b[33mCreation time:\x1b[0m        ' + new Date().toLocaleString());
		console.log('');
		console.log('\x1b[33mNetwork ID:\x1b[0m           ' + networkID);
		console.log('\x1b[33mName:\x1b[0m                 ' + name);
		if (args.description) console.log('\x1b[33mDescription:\x1b[0m          ' + args.description);
		console.log('\x1b[33mBootstrap peers:\x1b[0m      ' + args.bootstrap.length);
		for (let i = 0; i < args.bootstrap.length; i++) {
			const prefix = i === 0 ? '' : '                          ';
			console.log(prefix + args.bootstrap[i]);
		}
		console.log('\x1b[33mOutput file:\x1b[0m          ' + outputFile);
		console.log('');
		await Bun.write(outputFile, JSON.stringify(network, null, '\t'));
		const endTime = Date.now();
		const elapsedMs = endTime - startTime;
		const networkFile = Bun.file(outputFile);
		const networkFileSize = networkFile.size;
		console.log('\x1b[33mNetwork file size:\x1b[0m    ' + formatBytes(networkFileSize));
		console.log('\x1b[33mElapsed time:\x1b[0m         ' + elapsedMs + 'ms');
		console.log('');
		console.log('\x1b[32mNetwork definition created successfully!\x1b[0m');
	} catch (error) {
		console.error('Error:', error);
		process.exit(1);
	}
}

main();
