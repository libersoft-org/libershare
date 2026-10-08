import { open } from 'node:fs/promises';
import { uptime } from 'node:os';
import { assertWindowsRequestOwner, WINDOWS_ELEVATION_HELPER_BUDGET_MS } from './network-helper-windows.ts';
import { applyIPv4 } from './system-network.ts';
import { applySystemTimeSettings } from './system-time.ts';
import { decodeNetworkHelperRequest, executeNetworkHelperRequest, networkHelperExitCode, networkHelperFailure, type NetworkHelperRequest, type NetworkHelperResponse } from './network-helper-protocol.ts';
import { runElevatedSave } from './system-time-helper.ts';
import { SAVE_BUDGET_MS } from './system-time-common.ts';
import { NETWORK_MANAGER_CHECKPOINT_TIMEOUT_SECONDS } from './system-network-linux.ts';
import { executeRecordedHelper } from './native/helper-results-executor.ts';
import { helperRequestHash } from './native/helper-results-store.ts';
import { runTimeAccessProbeArgument } from './native/linux/time-access-probe.ts';

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

async function readRequest(args: string[]): Promise<{ request: NetworkHelperRequest; hash: string }> {
	const decode = (encoded: string): { request: NetworkHelperRequest; hash: string } => ({ request: decodeNetworkHelperRequest(encoded), hash: helperRequestHash(encoded) });
	if (args.length === 1 && args[0] === '--stdin') return decode(Buffer.from(await readBoundedStdin()).toString('base64url'));
	if (args.length === 2 && args[0] === '--request') return decode(args[1]!);
	if (reportsWithExitCode(args)) {
		// Read first, then check the owner. The launcher holds the file open for one
		// unbroken stretch that starts before this process exists, so a launcher
		// still alive here proves nothing could have rewritten what was just read.
		const content = await readBoundedFile(args[1]!);
		if (process.platform === 'win32') await assertWindowsRequestOwner(args[1]!);
		return decode(Buffer.from(content).toString('base64url'));
	}
	throw new Error('network helper request is missing');
}

const args = process.argv.slice(2);
if (args[0] === '--access-probe') process.exit(args.length === 2 ? await runTimeAccessProbeArgument(args[1]!).catch(() => 3) : 3);
const reportWithExitCode = reportsWithExitCode(args);

/** Cooperative budget for new time steps; an active native call is never terminated. */
function budgetCap(): number {
	return reportWithExitCode && process.platform === 'win32' ? WINDOWS_ELEVATION_HELPER_BUDGET_MS : SAVE_BUDGET_MS;
}

let response: NetworkHelperResponse;
try {
	const { request: incoming, hash } = await readRequest(args);
	const deadline = incoming.operation === 'applySystemTime' ? incoming.deadlineUptime : undefined;
	response = await executeRecordedHelper(
		incoming,
		hash,
		() =>
			executeNetworkHelperRequest(
				incoming,
				(interfaceID, config, expected) => applyIPv4(interfaceID, config, '', false, expected),
				changes => runElevatedSave(changes, deadline, budgetCap(), uptime(), applySystemTimeSettings)
			),
		incoming.operation === 'applySystemTime' ? budgetCap() : NETWORK_MANAGER_CHECKPOINT_TIMEOUT_SECONDS * 1000 + 15000,
		undefined,
		// Every network and time write in the helper goes through a native context call.
		true
	);
} catch (error) {
	response = networkHelperFailure(error);
}
if (reportWithExitCode) process.exitCode = networkHelperExitCode(response);
else process.stdout.write(JSON.stringify(response));
