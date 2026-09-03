import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { productIdentifier } from '@shared';
import { expectedNetworkHelperHash, sha256File } from './network-helper-integrity.ts';
import { NETWORK_MANAGER_CHECKPOINT_TIMEOUT_SECONDS } from './system-network-linux.ts';
import { encodeNetworkHelperRequest, NETWORK_HELPER_EXIT, parseNetworkHelperResponse, type NetworkHelperFailure, type NetworkHelperRequest, type NetworkHelperResponse } from './network-helper-protocol.ts';
import { verifyWindowsInstalledHelper, verifyWindowsInstalledSibling, WINDOWS_LAUNCHER_EXIT, WINDOWS_LAUNCHER_FILE, windowsPowerShellPath, windowsSystemEnvironment } from './network-helper-windows.ts';

const execFileAsync = promisify(execFile);
/**
 * Longer than the longest transaction a helper may run: the NetworkManager
 * checkpoint window (profile change, activation, explicit rollback and its
 * safety margin), plus room for the outcome to be reported. Killing the helper
 * earlier would abandon a rollback in progress, release the host lock, and let
 * the backend publish a state that is still changing.
 */
export const HELPER_TIMEOUT_MS: number = NETWORK_MANAGER_CHECKPOINT_TIMEOUT_SECONDS * 1000 + 15_000;
const MAX_HELPER_OUTPUT_BYTES = 4096;
export const MAC_HELPER_SHELL = 'set -eu; d=$(/usr/bin/mktemp -d /private/var/tmp/lish-network-helper.XXXXXX); trap \'/bin/rm -f "$d/helper"; /bin/rmdir "$d"\' EXIT HUP INT TERM; /bin/cp "$1" "$d/helper"; /usr/bin/codesign --verify --strict "$d/helper"; t=$(/usr/bin/codesign -dv --verbose=4 "$d/helper" 2>&1 | /usr/bin/awk -F= \'/^TeamIdentifier=/{print $2}\'); i=$(/usr/bin/codesign -dv --verbose=4 "$d/helper" 2>&1 | /usr/bin/awk -F= \'/^Identifier=/{print $2}\'); h=$(/usr/bin/shasum -a 256 "$d/helper" | /usr/bin/awk \'{print $1}\'); [ -n "$t" ] && [ "$t" = "$3" ] && [ "$h" = "$4" ] && [ "$i" = "$5" ]; "$d/helper" --request "$2"';

export function macNetworkHelperScript(): string {
	return 'on run argv\nset helperPath to item 1 of argv\nset requestValue to item 2 of argv\nset expectedTeam to item 3 of argv\nset expectedHash to item 4 of argv\nset expectedIdentifier to item 5 of argv\nset shellProgram to item 6 of argv\ndo shell script "/bin/sh -c " & quoted form of shellProgram & " sh " & quoted form of helperPath & " " & quoted form of requestValue & " " & quoted form of expectedTeam & " " & quoted form of expectedHash & " " & quoted form of expectedIdentifier with administrator privileges\nend run';
}

export function linuxNetworkHelperArgs(helperPath: string): string[] {
	return [helperPath, '--stdin'];
}

export function networkHelperPath(platform: NodeJS.Platform = process.platform, executablePath: string = process.execPath): string {
	if (platform === 'linux') return '/usr/libexec/libershare/lish-network-helper';
	return join(dirname(executablePath), platform === 'win32' ? 'lish-network-helper.exe' : 'lish-network-helper');
}

export function windowsNetworkLauncherPath(executablePath: string = process.execPath): string {
	return join(dirname(executablePath), WINDOWS_LAUNCHER_FILE);
}

export function trustedLinuxHelperMetadata(uid: number, mode: number, regularFile: boolean): boolean {
	return regularFile && uid === 0 && (mode & 0o22) === 0;
}

async function trustedUnixPath(path: string, requireFile: boolean): Promise<boolean> {
	const info = await stat(path);
	return info.uid === 0 && (info.mode & 0o22) === 0 && (requireFile ? info.isFile() : info.isDirectory());
}

export function macAppBundleRoot(path: string): string | null {
	return path.match(/^(\/Applications\/[^/]+\.app)(?:\/|$)/)?.[1] ?? null;
}

async function verifyLinuxHelper(helper: string): Promise<boolean> {
	if (helper !== '/usr/libexec/libershare/lish-network-helper' || !['/usr/bin/pkexec', '/bin/pkexec'].some(existsSync)) return false;
	try {
		const expectedHash = expectedNetworkHelperHash();
		if (!expectedHash || (await sha256File(helper)) !== expectedHash) return false;
		return (await trustedUnixPath('/usr/libexec', false)) && (await trustedUnixPath('/usr/libexec/libershare', false)) && (await trustedUnixPath(helper, true));
	} catch {
		return false;
	}
}

async function verifyWindowsHelper(helper: string): Promise<boolean> {
	const expectedHash = expectedNetworkHelperHash();
	const launcher = windowsNetworkLauncherPath();
	if (expectedHash === null || !(await verifyWindowsInstalledHelper(helper, process.execPath, expectedHash)) || !(await verifyWindowsInstalledSibling(launcher, process.execPath))) return false;
	const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
	const script = `$ErrorActionPreference='Stop'; $s=@(${[helper, launcher, process.execPath].map(quote).join(',')} | ForEach-Object { Get-AuthenticodeSignature -LiteralPath $_ }); if ($s.Count -ne 3 -or @($s | Where-Object { $_.Status -ne 'Valid' -or -not $_.SignerCertificate }).Count -ne 0 -or @($s.SignerCertificate.Thumbprint | Select-Object -Unique).Count -ne 1) { exit 3 }`;
	try {
		await execFileAsync(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10_000, maxBuffer: 1024, windowsHide: true, env: windowsSystemEnvironment() });
		return true;
	} catch {
		return false;
	}
}

interface MacCodeIdentity {
	team: string;
	identifier: string;
}

async function macCodeIdentity(path: string, deep: boolean = false): Promise<MacCodeIdentity | null> {
	try {
		await execFileAsync('/usr/bin/codesign', ['--verify', ...(deep ? ['--deep'] : []), '--strict', path], { timeout: 10_000 });
		const { stderr } = await execFileAsync('/usr/bin/codesign', ['-dv', '--verbose=4', path], { timeout: 10_000 });
		const team = stderr.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
		const identifier = stderr.match(/^Identifier=(.+)$/m)?.[1]?.trim();
		return team && identifier ? { team, identifier } : null;
	} catch {
		return null;
	}
}

async function verifyMacHelper(helper: string): Promise<boolean> {
	if (!existsSync('/usr/bin/osascript') || !existsSync('/usr/bin/codesign')) return false;
	try {
		const [resolvedHelper, resolvedBackend] = await Promise.all([realpath(helper), realpath(process.execPath)]);
		const helperRoot = macAppBundleRoot(resolvedHelper);
		const backendRoot = macAppBundleRoot(resolvedBackend);
		if (!helperRoot || helperRoot !== backendRoot) return false;
		const [helperIdentity, backendIdentity, bundleIdentity] = await Promise.all([macCodeIdentity(resolvedHelper), macCodeIdentity(resolvedBackend), macCodeIdentity(helperRoot, true)]);
		return helperIdentity !== null && backendIdentity !== null && bundleIdentity !== null && helperIdentity.team === backendIdentity.team && helperIdentity.team === bundleIdentity.team && helperIdentity.identifier === `${productIdentifier}.network-helper` && backendIdentity.identifier === `${productIdentifier}.backend` && bundleIdentity.identifier === productIdentifier;
	} catch {
		return false;
	}
}

export async function networkHelperAvailable(platform: NodeJS.Platform = process.platform): Promise<boolean> {
	const helper = networkHelperPath(platform);
	if (!existsSync(helper)) return false;
	if (platform === 'linux') return verifyLinuxHelper(helper);
	if (platform === 'darwin') return verifyMacHelper(helper);
	return platform === 'win32' && verifyWindowsHelper(helper);
}

/** What each launcher exit code means to the person who pressed Save. */
export const WINDOWS_LAUNCHER_MESSAGES: Readonly<Record<number, string>> = {
	[NETWORK_HELPER_EXIT.rejected]: 'the privileged network helper could not apply the change',
	[WINDOWS_LAUNCHER_EXIT.untrusted]: 'the privileged network helper is missing or not trusted',
	[WINDOWS_LAUNCHER_EXIT.cancelled]: 'the administrator prompt was cancelled',
	[WINDOWS_LAUNCHER_EXIT.timeout]: 'the privileged network helper timed out',
};

export function windowsLauncherFailure(exitCode: unknown): NetworkHelperFailure {
	if (exitCode === NETWORK_HELPER_EXIT.stale) return { ok: false, error: 'the interface configuration changed while the administrator prompt was open', code: 'NETCONFIG_STALE' };
	const message = typeof exitCode === 'number' ? WINDOWS_LAUNCHER_MESSAGES[exitCode] : undefined;
	return { ok: false, error: message ?? 'the privileged network helper failed' };
}

async function runWindowsHelper(encoded: string): Promise<NetworkHelperResponse> {
	try {
		await execFileAsync(windowsNetworkLauncherPath(), ['--request', encoded], { timeout: HELPER_TIMEOUT_MS + 5000, maxBuffer: MAX_HELPER_OUTPUT_BYTES, windowsHide: true, cwd: dirname(windowsNetworkLauncherPath()) });
		return { ok: true };
	} catch (error) {
		// A killed launcher is this timeout firing: the wait for the administrator
		// prompt happens inside ShellExecuteExW, which the launcher cannot bound
		// itself, so the caller's timeout is the one that ends it.
		const failure = error as { code?: unknown; killed?: boolean } | null;
		return windowsLauncherFailure(failure?.killed ? WINDOWS_LAUNCHER_EXIT.timeout : failure?.code);
	}
}

async function runMacHelper(helper: string, encoded: string): Promise<string> {
	const [backend, expectedHash] = await Promise.all([macCodeIdentity(process.execPath), sha256File(helper)]);
	if (!backend) throw new Error('privileged network helper signature is unavailable');
	const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', macNetworkHelperScript(), '--', helper, encoded, backend.team, expectedHash, `${productIdentifier}.network-helper`, MAC_HELPER_SHELL], { timeout: HELPER_TIMEOUT_MS, maxBuffer: MAX_HELPER_OUTPUT_BYTES });
	return stdout;
}

async function collectBounded(stream: NodeJS.ReadableStream): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const value of stream) {
		const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
		size += chunk.length;
		if (size > MAX_HELPER_OUTPUT_BYTES) throw new Error('network helper returned an oversized response');
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString('utf8');
}

async function runLinuxHelper(helper: string, request: NetworkHelperRequest): Promise<string> {
	const pkexec = existsSync('/usr/bin/pkexec') ? '/usr/bin/pkexec' : '/bin/pkexec';
	const child = spawn(pkexec, linuxNetworkHelperArgs(helper), { stdio: ['pipe', 'pipe', 'pipe'] });
	child.stdin.end(JSON.stringify(request));
	const timeout = setTimeout(() => child.kill(), HELPER_TIMEOUT_MS);
	const closed = new Promise<number | null>((resolve, reject) => {
		child.once('error', reject);
		child.once('close', resolve);
	});
	let stdout: string;
	let stderr: string;
	let code: number | null;
	try {
		[stdout, stderr, code] = await Promise.all([collectBounded(child.stdout), collectBounded(child.stderr), closed]);
	} catch (error) {
		child.kill();
		throw error;
	} finally {
		clearTimeout(timeout);
	}
	if (code !== 0) throw new Error(stderr.trim() || `network helper exited with ${code}`);
	return stdout;
}

export async function runElevatedNetworkHelper(request: NetworkHelperRequest, platform: NodeJS.Platform = process.platform): Promise<NetworkHelperResponse> {
	const helper = networkHelperPath(platform);
	if (!(await networkHelperAvailable(platform))) throw new Error('privileged network helper is not available or trusted');
	const encoded = encodeNetworkHelperRequest(request);
	if (platform === 'win32') return runWindowsHelper(encoded);
	const output = platform === 'darwin' ? await runMacHelper(helper, encoded) : await runLinuxHelper(helper, request);
	return parseNetworkHelperResponse(output);
}
