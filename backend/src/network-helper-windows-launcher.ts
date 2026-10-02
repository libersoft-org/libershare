import { dirname, join } from 'node:path';
import { uptime } from 'node:os';
import { productName } from '@shared';
import { expectedNetworkHelperHash, HASH_READ_LIMIT_MS, HelperVerificationTimeoutError } from './network-helper-integrity.ts';
import { decodeNetworkHelperRequest, type NetworkHelperRequest } from './network-helper-protocol.ts';
import { elevatedSaveBudget, systemTimeExitCode } from './system-time-helper.ts';
import { runElevatedWindowsProcess, verifyWindowsInstalledHelper, WINDOWS_ELEVATION_WAIT_MS, WINDOWS_NETWORK_ELEVATION_WAIT_MS, WINDOWS_LAUNCHER_EXIT, windowsCurrentProcessIdentity, windowsHelperParameters, windowsLocalAppDataPath, windowsRequestFileName, writeWindowsRequestFile } from './network-helper-windows.ts';

/**
 * Resolve the outcome of one elevation request as an exit code.
 *
 * Nothing is written to stdout or stderr: this process is spawned with no
 * console, and an escaping exception would only produce an unread stack trace.
 * The exit code is the whole channel back to the backend.
 */
/**
 * How long to wait for THIS request, read off the request itself.
 *
 * A time save is a handful of commands; a network change is a transaction with its own read,
 * change and read-back. Anything unrecognised - including a request this launcher cannot parse
 * - gets the longer wait: cutting an operation short is the failure that matters here, and the
 * helper validates the request properly on its own side regardless of what is guessed here.
 */
function elevationWaitFor(request: string): number {
	try {
		return (JSON.parse(request) as { operation?: unknown }).operation === 'applySystemTime' ? WINDOWS_ELEVATION_WAIT_MS : WINDOWS_NETWORK_ELEVATION_WAIT_MS;
	} catch {
		return WINDOWS_NETWORK_ELEVATION_WAIT_MS;
	}
}

/** Read the time deadline before verification or creating a request file. */
function systemTimeRequest(encoded: string): Extract<NetworkHelperRequest, { operation: 'applySystemTime' }> | null {
	try {
		const request = decodeNetworkHelperRequest(encoded);
		return request.operation === 'applySystemTime' ? request : null;
	} catch {
		return null;
	}
}

async function elevate(args: string[]): Promise<number> {
	if (args.length !== 2 || args[0] !== '--request' || !/^[A-Za-z0-9_-]{1,8192}$/.test(args[1]!)) return 1;
	const helper = join(dirname(process.execPath), 'lish-network-helper.exe');
	const expectedHash = expectedNetworkHelperHash();
	const decoded = Buffer.from(args[1]!, 'base64url').toString('utf8');
	const timeRequest = systemTimeRequest(args[1]!);
	const remaining = (): number | null => (timeRequest ? elevatedSaveBudget(timeRequest.deadlineUptime, HASH_READ_LIMIT_MS, uptime()) : HASH_READ_LIMIT_MS);
	const timeFailure = systemTimeExitCode({ success: false, outcome: 'error', message: null });
	const timeoutMs = remaining();
	if (timeoutMs === null) return timeFailure;
	let trusted: boolean;
	try {
		trusted = !!expectedHash && (await verifyWindowsInstalledHelper(helper, process.execPath, expectedHash, { timeoutMs }));
	} catch (error) {
		if (!(error instanceof HelperVerificationTimeoutError)) throw error;
		// Not verified in time, and nothing elevated: a time save gets its own "error" outcome,
		// which carries no change flag; anything else keeps the plain failure.
		return timeRequest ? timeFailure : 1;
	}
	if (!trusted) return WINDOWS_LAUNCHER_EXIT.untrusted;
	if (remaining() === null) return timeFailure;
	const request = writeWindowsRequestFile(join(windowsLocalAppDataPath(), productName, windowsRequestFileName(windowsCurrentProcessIdentity())), decoded);
	try {
		if (remaining() === null) return timeFailure;
		const outcome = await runElevatedWindowsProcess(helper, windowsHelperParameters(request.path), elevationWaitFor(decoded));
		if (outcome.kind === 'cancelled') return WINDOWS_LAUNCHER_EXIT.cancelled;
		if (outcome.kind === 'denied') return WINDOWS_LAUNCHER_EXIT.denied;
		if (outcome.kind === 'timeout') return WINDOWS_LAUNCHER_EXIT.timeout;
		return outcome.code;
	} finally {
		request.release();
	}
}

try {
	process.exitCode = await elevate(process.argv.slice(2));
} catch {
	process.exitCode = 1;
}
