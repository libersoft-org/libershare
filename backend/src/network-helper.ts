import { applyIPv4 } from './system-network.ts';
import { decodeNetworkHelperRequest, executeNetworkHelperRequest, networkHelperFailure, type NetworkHelperRequest, type NetworkHelperResponse } from './network-helper-protocol.ts';

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

/**
 * True when the caller wants the outcome as an exit code rather than on stdout.
 *
 * Read from the argument shape alone, before the request is decoded, so that a
 * malformed request still reports through the channel the caller is listening
 * on. The Windows launcher never sees the elevated helper's stdout.
 */
export function reportsWithExitCode(args: string[]): boolean {
	return args.length === 3 && args[0] === '--request' && args[2] === '--exit-code';
}

async function readRequest(args: string[]): Promise<NetworkHelperRequest> {
	if (args.length === 1 && args[0] === '--stdin') return decodeNetworkHelperRequest(Buffer.from(await readBoundedStdin()).toString('base64url'));
	if ((args.length === 2 || reportsWithExitCode(args)) && args[0] === '--request') return decodeNetworkHelperRequest(args[1]!);
	throw new Error('network helper request is missing');
}

const args = process.argv.slice(2);
const reportWithExitCode = reportsWithExitCode(args);
let response: NetworkHelperResponse;
try {
	response = await executeNetworkHelperRequest(await readRequest(args), (interfaceID, config) => applyIPv4(interfaceID, config, '', false));
} catch (error) {
	response = networkHelperFailure(error);
}
if (reportWithExitCode) process.exitCode = response.ok ? 0 : 10;
else process.stdout.write(JSON.stringify(response));
