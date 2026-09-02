import { open } from 'node:fs/promises';
import { applyIPv4 } from './system-network.ts';
import { decodeNetworkHelperRequest, executeNetworkHelperRequest, networkHelperExitCode, networkHelperFailure, type NetworkHelperRequest, type NetworkHelperResponse } from './network-helper-protocol.ts';

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

async function readBoundedFile(path: string): Promise<string> {
	const handle = await open(path, 'r');
	try {
		const buffer = Buffer.alloc(MAX_REQUEST_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > MAX_REQUEST_BYTES) throw new Error('network helper request is too large');
		return buffer.subarray(0, bytesRead).toString('utf8');
	} finally {
		await handle.close();
	}
}

/**
 * True when the caller wants the outcome as an exit code rather than on stdout.
 *
 * That is the file mode, which exists for the Windows launcher: it never sees
 * the elevated helper's stdout, and it keeps the request out of the command line
 * UAC shows to the user. Decided from the argument shape alone, before the
 * request is decoded, so a malformed request still reports through the channel
 * the caller is listening on.
 */
function reportsWithExitCode(args: string[]): boolean {
	return args.length === 2 && args[0] === '--request-file';
}

async function readRequest(args: string[]): Promise<NetworkHelperRequest> {
	if (args.length === 1 && args[0] === '--stdin') return decodeNetworkHelperRequest(Buffer.from(await readBoundedStdin()).toString('base64url'));
	if (args.length === 2 && args[0] === '--request') return decodeNetworkHelperRequest(args[1]!);
	if (reportsWithExitCode(args)) return decodeNetworkHelperRequest(Buffer.from(await readBoundedFile(args[1]!)).toString('base64url'));
	throw new Error('network helper request is missing');
}

const args = process.argv.slice(2);
const reportWithExitCode = reportsWithExitCode(args);
let response: NetworkHelperResponse;
try {
	response = await executeNetworkHelperRequest(await readRequest(args), (interfaceID, config, expected) => applyIPv4(interfaceID, config, '', false, expected));
} catch (error) {
	response = networkHelperFailure(error);
}
if (reportWithExitCode) process.exitCode = networkHelperExitCode(response);
else process.stdout.write(JSON.stringify(response));
