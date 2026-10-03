import { dirname, join } from 'node:path';
import { uptime } from 'node:os';
import { productName } from '@shared';
import { expectedNetworkHelperHash, HASH_READ_LIMIT_MS, HelperVerificationTimeoutError } from './network-helper-integrity.ts';
import { decodeNetworkHelperRequest, NETWORK_HELPER_EXIT } from './network-helper-protocol.ts';
import { elevatedSaveBudget, systemTimeExitCode } from './system-time-helper.ts';
import { runElevatedWindowsProcess, verifyWindowsInstalledHelper, WINDOWS_LAUNCHER_EXIT, windowsCurrentProcessIdentity, windowsHelperParameters, windowsLocalAppDataPath, windowsRequestFileName, writeWindowsRequestFile } from './network-helper-windows.ts';

/**
 * Resolve the outcome of one elevation request as an exit code.
 *
 * Nothing is written to stdout or stderr: this process is spawned with no
 * console, and an escaping exception would only produce an unread stack trace.
 * The backend reads the protected result record after the launcher exits.
 */
async function elevate(args: string[]): Promise<number> {
	if (args.length !== 2 || args[0] !== '--request' || !/^[A-Za-z0-9_-]{1,8192}$/.test(args[1]!)) return 1;
	const incoming = decodeNetworkHelperRequest(args[1]!);
	const helper = join(dirname(process.execPath), 'lish-network-helper.exe');
	const expectedHash = expectedNetworkHelperHash();
	const decoded = Buffer.from(args[1]!, 'base64url').toString('utf8');
	const timeRequest = incoming.operation === 'applySystemTime';
	const remaining = (): number | null => elevatedSaveBudget(incoming.deadlineUptime, HASH_READ_LIMIT_MS, uptime());
	const timeFailure = systemTimeExitCode({ success: false, outcome: 'error', message: null });
	const timeoutMs = remaining();
	if (timeoutMs === null) return timeRequest ? timeFailure : NETWORK_HELPER_EXIT.rejected;
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
	if (remaining() === null) return timeRequest ? timeFailure : NETWORK_HELPER_EXIT.rejected;
	const request = writeWindowsRequestFile(join(windowsLocalAppDataPath(), productName, windowsRequestFileName(windowsCurrentProcessIdentity())), decoded);
	try {
		if (remaining() === null) return timeRequest ? timeFailure : NETWORK_HELPER_EXIT.rejected;
		const outcome = await runElevatedWindowsProcess(helper, windowsHelperParameters(request.path));
		if (outcome.kind === 'cancelled') return WINDOWS_LAUNCHER_EXIT.cancelled;
		if (outcome.kind === 'denied') return WINDOWS_LAUNCHER_EXIT.denied;
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
