import { dirname, join } from 'node:path';
import { productName } from '@shared';
import { expectedNetworkHelperHash } from './network-helper-integrity.ts';
import { runElevatedWindowsProcess, verifyWindowsInstalledHelper, WINDOWS_LAUNCHER_EXIT, windowsHelperParameters, windowsLocalAppDataPath, writeWindowsRequestFile } from './network-helper-windows.ts';

/**
 * Resolve the outcome of one elevation request as an exit code.
 *
 * Nothing is written to stdout or stderr: this process is spawned with no
 * console, and an escaping exception would only produce an unread stack trace.
 * The exit code is the whole channel back to the backend.
 */
async function elevate(args: string[]): Promise<number> {
	if (args.length !== 2 || args[0] !== '--request' || !/^[A-Za-z0-9_-]{1,8192}$/.test(args[1]!)) return 1;
	const helper = join(dirname(process.execPath), 'lish-network-helper.exe');
	const expectedHash = expectedNetworkHelperHash();
	if (!expectedHash || !(await verifyWindowsInstalledHelper(helper, process.execPath, expectedHash))) return WINDOWS_LAUNCHER_EXIT.untrusted;
	const request = writeWindowsRequestFile(join(windowsLocalAppDataPath(), productName, 'network-request.json'), Buffer.from(args[1]!, 'base64url').toString('utf8'));
	try {
		const outcome = await runElevatedWindowsProcess(helper, windowsHelperParameters(request.path), 180_000);
		if (outcome.kind === 'cancelled') return WINDOWS_LAUNCHER_EXIT.cancelled;
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
