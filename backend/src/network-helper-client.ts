import { execFile, spawn } from 'node:child_process';
import { uptime as osUptime } from 'node:os';
import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { productIdentifier, type SystemTimeChanges, type SystemTimeResult } from '@shared';
import { parseSystemTimeExitCode, systemTimeHelperFailure } from './system-time-helper.ts';
import { remainingSaveBudget } from './system-time-common.ts';
import { expectedNetworkHelperHash, HelperVerificationTimeoutError, sha256File, trustIdentity } from './network-helper-integrity.ts';
import { NETWORK_MANAGER_CHECKPOINT_TIMEOUT_SECONDS } from './system-network-linux.ts';
import { encodeNetworkHelperRequest, NETWORK_HELPER_EXIT, parseNetworkHelperResponse, type NetworkHelperFailure, type NetworkHelperRequest, type NetworkHelperResponse } from './network-helper-protocol.ts';
import { elevationClock, verifyWindowsInstalledHelper, verifyWindowsInstalledSibling, WINDOWS_ELEVATION_PROMPT_ALLOWANCE_MS, WINDOWS_ELEVATION_WAIT_MS, WINDOWS_NETWORK_ELEVATION_WAIT_MS, WINDOWS_LAUNCHER_EXIT, WINDOWS_LAUNCHER_FILE, windowsPowerShellPath, windowsSystemEnvironment } from './network-helper-windows.ts';

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
/**
 * How long the three binaries may take to have their signatures checked.
 *
 * Authenticode re-hashes every byte of each file, and these are single-file
 * builds of a runtime: three of them is roughly a third of a gigabyte to read on
 * a cold cache. Measured at 7.6-8.2 s on an idle test machine, so a ten-second
 * budget had no margin at all — and the only thing a caller learns from an
 * expired one is that the helper is "not trusted", which silently turns the
 * network screen read-only on a machine that is merely slow.
 */
export const SIGNATURE_TIMEOUT_MS = 30_000;

/**
 * How long the launcher may be left running for one system-time save.
 *
 * It has to outlast the launcher, because the launcher is what holds the elevated process's
 * handle and terminates it on its own timeout. Killed first, this call leaves an elevated
 * helper running with nothing watching it - and the save then reports a finished operation and
 * releases the lock while the host may still be being changed.
 *
 * So it covers BOTH parts, which the previous figure did not: the prompt, whose time is spent
 * inside `ShellExecuteExW` before the launcher's wait starts counting at all, and the work the
 * wait actually bounds. Deliberately NOT the network path's {@link HELPER_TIMEOUT_MS} either -
 * that is a NetworkManager checkpoint window and nothing in a time save creates one.
 */
export const WINDOWS_TIME_HELPER_TIMEOUT_MS: number = WINDOWS_ELEVATION_PROMPT_ALLOWANCE_MS + WINDOWS_ELEVATION_WAIT_MS + 20_000;
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
	} catch (error) {
		// Out of time is not a verdict about the helper; the caller reports it as such.
		if (error instanceof HelperVerificationTimeoutError) throw error;
		return false;
	}
}

/**
 * How long a FAILED Windows trust check is remembered for the same three files.
 *
 * Only failures expire. A pass is remembered for as long as the files are untouched, but a
 * failure can be transient - the signature check is an external process with a timeout, and
 * a machine under load can miss it - so caching that answer for the life of the process
 * would keep elevation broken until a restart. Short enough to recover on the next attempt,
 * long enough that a genuinely untrusted install does not re-read a third of a gigabyte on
 * every status poll.
 *
 * Measured against {@link elevationClock}, which is monotonic, and NOT against the wall
 * clock: this code path exists to serve a screen whose whole purpose is moving that clock.
 * With `Date.now()` a correction backwards makes the stored failure's age negative, so it
 * never reaches the limit - measured at an hour back, the 30-second memory lasted an hour
 * and 30 seconds and went on refusing an elevation whose cause was long gone.
 */
const WINDOWS_TRUST_FAILURE_TTL_MS = 30_000;

/** The last Windows trust answer, against the identity of the files it was measured on. */
let windowsTrust: { identity: string; trusted: boolean; at: number } | null = null;

/** The identity of the three binaries the check covers, or null when one cannot be read. */
async function windowsTrustIdentity(paths: readonly string[]): Promise<string | null> {
	const stats = await Promise.all(paths.map(path => stat(path).catch(() => null)));
	if (stats.some(entry => entry === null)) return null;
	return trustIdentity(stats.map((entry, index) => ({ path: paths[index]!, size: entry!.size, mtimeMs: entry!.mtimeMs, ctimeMs: entry!.ctimeMs, ino: entry!.ino })));
}

function rememberedWindowsTrust(identity: string | null, now: number): boolean | null {
	if (identity === null || windowsTrust === null || windowsTrust.identity !== identity) return null;
	if (!windowsTrust.trusted && now - windowsTrust.at >= WINDOWS_TRUST_FAILURE_TTL_MS) return null;
	return windowsTrust.trusted;
}

/** One verification of the same files at a time; a second caller joins it instead of repeating it. */
let windowsTrustInFlight: { identity: string; answer: Promise<boolean> } | null = null;

export async function verifyWindowsHelper(helper: string, now: () => number = elevationClock): Promise<boolean> {
	const expectedHash = expectedNetworkHelperHash();
	const launcher = windowsNetworkLauncherPath();
	// Before the expensive part: the same three files, unchanged, were already measured.
	const identity = await windowsTrustIdentity([helper, launcher, process.execPath]);
	const remembered = rememberedWindowsTrust(identity, now());
	if (remembered !== null) return remembered;
	if (identity !== null && windowsTrustInFlight?.identity === identity) return windowsTrustInFlight.answer;
	const answer = measureWindowsHelperTrust(helper, launcher, expectedHash, now);
	if (identity !== null) windowsTrustInFlight = { identity, answer };
	try {
		const trusted = await answer;
		if (identity !== null) windowsTrust = { identity, trusted, at: now() };
		return trusted;
	} finally {
		if (windowsTrustInFlight?.answer === answer) windowsTrustInFlight = null;
	}
}

/**
 * Measure the trust chain ahead of the save that needs it, off the request path.
 *
 * The verification is 9-14 seconds of reading three single-file runtime builds, and paying
 * it inside the save is what the user sees as a screen that sits still before the elevation
 * prompt appears. Running it when the time screen first reads the host means the answer is
 * usually already cached by the time Save is pressed. Deliberately not awaited and never
 * allowed to throw: it is a warm-up, and the save verifies for itself regardless.
 */
export function warmElevationTrust(platform: NodeJS.Platform = process.platform): void {
	if (platform !== 'win32') return;
	void networkHelperAvailable(platform).catch(() => undefined);
}

/**
 * One Windows trust measurement: hash, location, then signatures, all inside a single
 * {@link SIGNATURE_TIMEOUT_MS} budget measured on the monotonic {@link elevationClock}. The hash
 * gets at most its own limit and the signature check only what is left. Running out of budget
 * throws {@link HelperVerificationTimeoutError} rather than answering "untrusted", so the result
 * is not cached as a failure and the next attempt measures again.
 */
async function measureWindowsHelperTrust(helper: string, launcher: string, expectedHash: string | null, now: () => number = elevationClock): Promise<boolean> {
	const deadline = now() + SIGNATURE_TIMEOUT_MS;
	const remaining = (): number => {
		const left = deadline - now();
		if (left <= 0) throw new HelperVerificationTimeoutError();
		return left;
	};
	// Every step, the file metadata reads included, ends at the one deadline.
	const bounded = <T>(work: Promise<T>): Promise<T> => {
		const left = remaining();
		work.catch(() => undefined);
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => reject(new HelperVerificationTimeoutError()), left);
			work.then(
				value => {
					clearTimeout(timer);
					resolve(value);
				},
				error => {
					clearTimeout(timer);
					reject(error);
				}
			);
		});
	};
	if (expectedHash === null || !(await bounded(verifyWindowsInstalledHelper(helper, process.execPath, expectedHash, { timeoutMs: remaining() }))) || !(await bounded(verifyWindowsInstalledSibling(launcher, process.execPath)))) return false;
	const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
	const script = `$ErrorActionPreference='Stop'; $s=@(${[helper, launcher, process.execPath].map(quote).join(',')} | ForEach-Object { Get-AuthenticodeSignature -LiteralPath $_ }); if ($s.Count -ne 3 -or @($s | Where-Object { $_.Status -ne 'Valid' -or -not $_.SignerCertificate }).Count -ne 0 -or @($s.SignerCertificate.Thumbprint | Select-Object -Unique).Count -ne 1) { exit 3 }`;
	// Outside the try: a budget already spent is a timeout, not a bad signature to cache.
	const timeout = Math.max(1, Math.floor(remaining()));
	try {
		await execFileAsync(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], { timeout, maxBuffer: 1024, windowsHide: true, env: windowsSystemEnvironment() });
		return true;
	} catch (error) {
		// Killed by the timeout is the budget running out, not a bad signature.
		if ((error as { killed?: boolean }).killed) throw new HelperVerificationTimeoutError();
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
	[WINDOWS_LAUNCHER_EXIT.denied]: 'this account may not elevate, so the change needs an administrator',
	[WINDOWS_LAUNCHER_EXIT.timeout]: 'the privileged network helper timed out',
};

export function windowsLauncherFailure(exitCode: unknown): NetworkHelperFailure {
	if (exitCode === NETWORK_HELPER_EXIT.stale) return { ok: false, error: 'the interface configuration changed while the administrator prompt was open', code: 'NETCONFIG_STALE' };
	const message = typeof exitCode === 'number' ? WINDOWS_LAUNCHER_MESSAGES[exitCode] : undefined;
	return { ok: false, error: message ?? 'the privileged network helper failed' };
}

/**
 * The network path's own limit, on the same reasoning as the time one.
 *
 * The prompt's time is spent inside `ShellExecuteExW` before the launcher's wait starts, so a
 * caller that allows only the wait can kill the launcher while it still believes it has time -
 * and the launcher is what holds the elevated process's handle. This was the case here as
 * well, from before the time work: 271 s against a prompt plus a 180 s wait.
 */
export const WINDOWS_NETWORK_HELPER_TIMEOUT_MS: number = WINDOWS_ELEVATION_PROMPT_ALLOWANCE_MS + WINDOWS_NETWORK_ELEVATION_WAIT_MS + 20_000;

async function runWindowsHelper(encoded: string): Promise<NetworkHelperResponse> {
	try {
		await execFileAsync(windowsNetworkLauncherPath(), ['--request', encoded], { timeout: WINDOWS_NETWORK_HELPER_TIMEOUT_MS, maxBuffer: MAX_HELPER_OUTPUT_BYTES, windowsHide: true, cwd: dirname(windowsNetworkLauncherPath()) });
		return { ok: true };
	} catch (error) {
		// A killed launcher is this timeout firing: the wait for the administrator
		// prompt happens inside ShellExecuteExW, which the launcher cannot bound
		// itself, so the caller's timeout is the one that ends it.
		const failure = error as { code?: unknown; killed?: boolean } | null;
		return windowsLauncherFailure(failure?.killed ? WINDOWS_LAUNCHER_EXIT.timeout : failure?.code);
	}
}

/** What the macOS helper launch needs, measured before anything is started. */
interface MacHelperLaunch {
	team: string;
	expectedHash: string;
}

/**
 * Everything the macOS launch needs before `osascript` runs. A failure here — including a hash
 * read that ran out of time ({@link HelperVerificationTimeoutError}) — means nothing was started.
 */
async function prepareMacHelper(helper: string): Promise<MacHelperLaunch> {
	const [backend, expectedHash] = await Promise.all([macCodeIdentity(process.execPath), sha256File(helper)]);
	if (!backend) throw new Error('privileged network helper signature is unavailable');
	return { team: backend.team, expectedHash };
}

async function launchMacHelper(helper: string, encoded: string, launch: MacHelperLaunch): Promise<string> {
	const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', macNetworkHelperScript(), '--', helper, encoded, launch.team, launch.expectedHash, `${productIdentifier}.network-helper`, MAC_HELPER_SHELL], { timeout: HELPER_TIMEOUT_MS, maxBuffer: MAX_HELPER_OUTPUT_BYTES });
	return stdout;
}

async function runMacHelper(helper: string, encoded: string): Promise<string> {
	return launchMacHelper(helper, encoded, await prepareMacHelper(helper));
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

/**
 * Run one system-time save with the rights the desktop process does not have.
 *
 * Same binary, same launcher, same signature and hash checks as the network apply -
 * a second privileged helper would have to re-earn all of that. The answer comes
 * back as the host's own {@link SystemTimeResult}, so the screen renders "switch
 * synchronisation off first" or "the host changed under your form" exactly as it
 * does for an unprivileged write.
 *
 * On Windows the exit code is the only channel out of an elevated process, so the
 * launcher's own codes have to be told apart from a packed outcome - and unlike the
 * network path, a non-zero status is the NORMAL case here (`ok` is 32, not 0), which
 * is why this does not reuse `runWindowsHelper`.
 */
export async function runElevatedSystemTime(changes: SystemTimeChanges, platform: NodeJS.Platform = process.platform, uptime: () => number = osUptime, available: (platform: NodeJS.Platform) => Promise<boolean> = networkHelperAvailable): Promise<SystemTimeResult> {
	const helper = networkHelperPath(platform);
	// Nothing has been started when the check runs out of time, so the result carries neither
	// change flag and no helper is launched afterwards.
	const notVerifiedInTime = (): SystemTimeResult => systemTimeHelperFailure('error', 'the privileged helper could not be verified in time, so nothing was changed');
	let trusted: boolean;
	try {
		trusted = await withinSaveBudget(available(platform));
	} catch (error) {
		if (error instanceof HelperVerificationTimeoutError) return notVerifiedInTime();
		throw error;
	}
	if (!trusted) return systemTimeHelperFailure('permission-denied', 'the privileged helper is not available or not trusted, so the change needs an elevated application');
	// The caller's deadline goes with the request. Expressed as the host uptime it expires
	// at, because that is the one clock the elevated process can compare against: a remaining
	// count would be measured before the consent prompt and read after it, and the wall clock
	// is what this very operation changes.
	const remaining = remainingSaveBudget();
	if (remaining !== null && remaining <= 0) return notVerifiedInTime();
	const request: NetworkHelperRequest = { version: 1, operation: 'applySystemTime', changes, ...(remaining === null ? {} : { deadlineUptime: uptime() + remaining / 1000 }) };
	if (platform === 'win32') return runWindowsSystemTime(encodeNetworkHelperRequest(request));
	let macLaunch: MacHelperLaunch | null = null;
	if (platform === 'darwin') {
		try {
			macLaunch = await withinSaveBudget(prepareMacHelper(helper));
		} catch (error) {
			if (error instanceof HelperVerificationTimeoutError) return notVerifiedInTime();
			return helperTransportFailure(error);
		}
		// The preparation may have used up the save: no authorization prompt after that.
		const left = remainingSaveBudget();
		if (left !== null && left <= 0) return notVerifiedInTime();
	}
	let response: NetworkHelperResponse;
	try {
		response = parseNetworkHelperResponse(macLaunch ? await launchMacHelper(helper, encodeNetworkHelperRequest(request), macLaunch) : await runLinuxHelper(helper, request));
	} catch (error) {
		// "We never got an answer" is not "nothing happened". A declined authorization is the
		// one failure that proves the helper never ran; everything else here - a killed
		// child, a truncated or unparsable answer, a non-zero exit after the helper was
		// already up - may have arrived AFTER the host was changed, so it has to carry
		// `stateMayHaveChanged` or the caller skips the read-back and every open window keeps
		// showing a state the host no longer has.
		return helperTransportFailure(error);
	}
	// A structured failure is the helper's own answer from BEFORE it applied anything: the
	// request decode and the operation dispatch are the only things that fail this way, now
	// that an exception out of the save itself comes back as a time result carrying
	// `stateMayHaveChanged` (see applySystemTimeReporting).
	if (!response.ok) return systemTimeHelperFailure('error', response.error);
	if (!('time' in response)) return { ...systemTimeHelperFailure('error', 'the privileged helper answered the wrong request'), stateMayHaveChanged: true };
	return response.time;
}

/** Text of a thrown value, bounded and free of control characters. */
function failureText(error: unknown): string {
	return (
		(error instanceof Error ? error.message : String(error))
			.replace(/\p{Cc}/gu, ' ')
			.trim()
			.slice(0, 500) || 'the privileged helper did not run'
	);
}

/**
 * Wait for `work` no longer than the running save has left. The work itself is not cancelled:
 * a shared trust measurement may still finish for another caller. Only this wait ends, with
 * {@link HelperVerificationTimeoutError}, so the expired save goes no further.
 */
function withinSaveBudget<T>(work: Promise<T>): Promise<T> {
	const remaining = remainingSaveBudget();
	if (remaining === null) return work;
	work.catch(() => undefined);
	if (remaining <= 0) return Promise.reject(new HelperVerificationTimeoutError());
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new HelperVerificationTimeoutError()), remaining);
		work.then(
			value => {
				clearTimeout(timer);
				resolve(value);
			},
			error => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

/**
 * A declined authorization, matched on what the two tools say when the person says no.
 *
 * `pkexec` documents exit 126 for "the authentication dialog was dismissed" and 127 for
 * "not authorized"; `osascript` reports a cancelled `with administrator privileges`
 * dialog as error -128. Both mean the helper was never started.
 */
const AUTHORIZATION_DECLINED_RE = /\bexited with 12[67]\b|-128|User canceled|not authorized/i;

export function helperTransportFailure(error: unknown): SystemTimeResult {
	const message = failureText(error);
	// The person said no, which is not the same as this process being unable to ask.
	if (AUTHORIZATION_DECLINED_RE.test(message)) return systemTimeHelperFailure('elevation-declined', message);
	return { ...systemTimeHelperFailure('error', message), stateMayHaveChanged: true };
}

/**
 * What each launcher exit code means to someone who pressed Save on the time screen.
 *
 * Only the three prove the helper never started: it was not trusted, the prompt was
 * declined, or the account may not elevate at all. A DECLINED prompt gets its own outcome,
 * because the advice differs - press Save and confirm, rather than restart the application
 * with more rights; the other two are a bare `permission-denied`.
 * A timeout is the helper being KILLED part-way, so it carries `stateMayHaveChanged`:
 * the change may already be on the host, and without the flag the caller skips the
 * read-back that would show it.
 */
const WINDOWS_LAUNCHER_TIME_FAILURES: Readonly<Record<number, SystemTimeResult>> = {
	[WINDOWS_LAUNCHER_EXIT.untrusted]: systemTimeHelperFailure('permission-denied', 'the privileged helper is missing or not trusted'),
	[WINDOWS_LAUNCHER_EXIT.cancelled]: systemTimeHelperFailure('elevation-declined', 'the administrator prompt was cancelled'),
	[WINDOWS_LAUNCHER_EXIT.denied]: systemTimeHelperFailure('permission-denied', 'this account may not elevate, so the change needs an administrator'),
	[WINDOWS_LAUNCHER_EXIT.timeout]: { ...systemTimeHelperFailure('error', 'the privileged helper timed out'), stateMayHaveChanged: true },
};

export function windowsSystemTimeExit(exitCode: unknown, killed: boolean = false): SystemTimeResult {
	if (killed) return WINDOWS_LAUNCHER_TIME_FAILURES[WINDOWS_LAUNCHER_EXIT.timeout]!;
	const code = typeof exitCode === 'number' ? exitCode : -1;
	// An unrecognised status is the dangerous one: it came from a launcher that got far
	// enough to answer, and nothing rules out the helper having run first.
	return parseSystemTimeExitCode(code) ?? WINDOWS_LAUNCHER_TIME_FAILURES[code] ?? { ...systemTimeHelperFailure('error', 'the privileged helper failed'), stateMayHaveChanged: true };
}

async function runWindowsSystemTime(encoded: string): Promise<SystemTimeResult> {
	const launcher = windowsNetworkLauncherPath();
	try {
		await execFileAsync(launcher, ['--request', encoded], { timeout: WINDOWS_TIME_HELPER_TIMEOUT_MS, maxBuffer: MAX_HELPER_OUTPUT_BYTES, windowsHide: true, cwd: dirname(launcher) });
		// Exit 0 is the network path's "applied" and never a packed time outcome, so a
		// helper that answered with it did not run the request this call made - but it DID
		// run something, so the host is not known to be untouched.
		return { ...systemTimeHelperFailure('error', 'the privileged helper answered the wrong request'), stateMayHaveChanged: true };
	} catch (error) {
		const failure = error as { code?: unknown; killed?: boolean } | null;
		return windowsSystemTimeExit(failure?.code, failure?.killed === true);
	}
}

export async function runElevatedNetworkHelper(request: NetworkHelperRequest, platform: NodeJS.Platform = process.platform): Promise<NetworkHelperResponse> {
	const helper = networkHelperPath(platform);
	if (!(await networkHelperAvailable(platform))) throw new Error('privileged network helper is not available or trusted');
	const encoded = encodeNetworkHelperRequest(request);
	if (platform === 'win32') return runWindowsHelper(encoded);
	const output = platform === 'darwin' ? await runMacHelper(helper, encoded) : await runLinuxHelper(helper, request);
	return parseNetworkHelperResponse(output);
}
