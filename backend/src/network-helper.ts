import { applyIPv4 } from './system-network.ts';
import { decodeNetworkHelperRequest, executeNetworkHelperRequest, type NetworkHelperRequest } from './network-helper-protocol.ts';

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

async function readRequest(args: string[]): Promise<{ request: NetworkHelperRequest; reportWithExitCode: boolean }> {
	if (args.length === 1 && args[0] === '--stdin') {
		const text = await readBoundedStdin();
		return { request: decodeNetworkHelperRequest(Buffer.from(text).toString('base64url')), reportWithExitCode: false };
	}
	if (args.length === 2 && args[0] === '--request') return { request: decodeNetworkHelperRequest(args[1]!), reportWithExitCode: false };
	if (args.length === 3 && args[0] === '--request' && args[2] === '--exit-code') return { request: decodeNetworkHelperRequest(args[1]!), reportWithExitCode: true };
	throw new Error('network helper request is missing');
}

const { request, reportWithExitCode } = await readRequest(process.argv.slice(2));
const response = await executeNetworkHelperRequest(request, (interfaceID, config) => applyIPv4(interfaceID, config, '', false));
if (reportWithExitCode) process.exitCode = response.ok ? 0 : 10;
else process.stdout.write(JSON.stringify(response));
