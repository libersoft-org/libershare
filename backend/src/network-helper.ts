import { applyIPv4 } from './system-network.ts';
import { decodeNetworkHelperRequest, executeNetworkHelperRequest, type NetworkHelperRequest } from './network-helper-protocol.ts';
import { createConnection } from 'node:net';

const MAX_REQUEST_BYTES = 12 * 1024;

async function readBoundedStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const value of Bun.stdin.stream()) {
		const chunk = Buffer.from(value);
		size += chunk.length;
		if (size > MAX_REQUEST_BYTES) throw new Error('network helper request is too large');
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString('utf8');
}

async function readRequest(args: string[]): Promise<{ request: NetworkHelperRequest; responsePipe: string | null }> {
	if (args.length === 1 && args[0] === '--stdin') {
		const text = await readBoundedStdin();
		return { request: decodeNetworkHelperRequest(Buffer.from(text).toString('base64url')), responsePipe: null };
	}
	if (args.length === 2 && args[0] === '--request') return { request: decodeNetworkHelperRequest(args[1]!), responsePipe: null };
	if (args.length === 4 && args[0] === '--request' && args[2] === '--response-pipe' && /^\\\\\.\\pipe\\lish-network-helper-[0-9a-f]{48}$/.test(args[3]!)) {
		return { request: decodeNetworkHelperRequest(args[1]!), responsePipe: args[3]! };
	}
	throw new Error('network helper request is missing');
}

async function writeResponse(text: string, responsePipe: string | null): Promise<void> {
	if (!responsePipe) {
		process.stdout.write(text);
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const socket = createConnection(responsePipe);
		socket.once('error', reject);
		socket.once('connect', () => socket.end(text, resolve));
	});
}

const { request, responsePipe } = await readRequest(process.argv.slice(2));
const response = await executeNetworkHelperRequest(request, (interfaceID, config) => applyIPv4(interfaceID, config, '', false));
await writeResponse(JSON.stringify(response), responsePipe);
