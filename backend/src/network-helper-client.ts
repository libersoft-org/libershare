import { execFile, spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { productIdentifier } from '@shared';
import { encodeNetworkHelperRequest, parseNetworkHelperResponse, type NetworkHelperRequest, type NetworkHelperResponse } from './network-helper-protocol.ts';
import { runElevatedWindowsProcess, windowsHelperParameters, windowsProgramFilesPath } from './network-helper-windows.ts';

const execFileAsync = promisify(execFile);
const HELPER_TIMEOUT_MS = 180_000;
const MAX_HELPER_OUTPUT_BYTES = 4096;
export const MAC_HELPER_SHELL = 'set -eu; d=$(/usr/bin/mktemp -d /private/var/tmp/lish-network-helper.XXXXXX); trap \'/bin/rm -f "$d/helper"; /bin/rmdir "$d"\' EXIT HUP INT TERM; /bin/cp "$1" "$d/helper"; /usr/bin/codesign --verify --strict "$d/helper"; t=$(/usr/bin/codesign -dv --verbose=4 "$d/helper" 2>&1 | /usr/bin/awk -F= \'/^TeamIdentifier=/{print $2}\'); i=$(/usr/bin/codesign -dv --verbose=4 "$d/helper" 2>&1 | /usr/bin/awk -F= \'/^Identifier=/{print $2}\'); h=$(/usr/bin/shasum -a 256 "$d/helper" | /usr/bin/awk \'{print $1}\'); [ -n "$t" ] && [ "$t" = "$3" ] && [ "$h" = "$4" ] && [ "$i" = "$5" ]; "$d/helper" --request "$2"';
declare const LISH_NETWORK_HELPER_SHA256: string | undefined;

function expectedHelperHash(): string | null {
	const value = typeof LISH_NETWORK_HELPER_SHA256 === 'string' ? LISH_NETWORK_HELPER_SHA256.toLowerCase() : '';
	return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

async function sha256File(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		const stream = createReadStream(path);
		stream.on('error', reject);
		stream.on('data', chunk => hash.update(chunk));
		stream.on('end', () => resolve(hash.digest('hex')));
	});
}

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
		const expectedHash = expectedHelperHash();
		if (!expectedHash || (await sha256File(helper)) !== expectedHash) return false;
		return (await trustedUnixPath('/usr/libexec', false)) && (await trustedUnixPath('/usr/libexec/libershare', false)) && (await trustedUnixPath(helper, true));
	} catch {
		return false;
	}
}

async function verifyWindowsHelper(helper: string): Promise<boolean> {
	const expectedHash = expectedHelperHash();
	if (!expectedHash) return false;
	try {
		const [resolvedHelper, resolvedBackend] = await Promise.all([realpath(helper), realpath(process.execPath)]);
		if (dirname(resolvedHelper).toLowerCase() !== dirname(resolvedBackend).toLowerCase()) return false;
		const prefix = `${windowsProgramFilesPath().replace(/[\\/]+$/, '')}\\`.toLowerCase();
		if (!resolvedBackend.toLowerCase().startsWith(prefix)) return false;
		return (await sha256File(resolvedHelper)) === expectedHash;
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

async function runWindowsHelper(helper: string, encoded: string): Promise<string> {
	const pipe = `\\\\.\\pipe\\lish-network-helper-${randomBytes(24).toString('hex')}`;
	let resolveResponse!: (value: string) => void;
	let rejectResponse!: (error: Error) => void;
	const response = new Promise<string>((resolve, reject) => {
		resolveResponse = resolve;
		rejectResponse = reject;
	});
	const server = createServer(socket => {
		const chunks: Buffer[] = [];
		let size = 0;
		socket.on('data', chunk => {
			size += chunk.length;
			if (size > MAX_HELPER_OUTPUT_BYTES) {
				rejectResponse(new Error('network helper returned an oversized response'));
				socket.destroy();
				return;
			}
			chunks.push(Buffer.from(chunk));
		});
		socket.once('error', rejectResponse);
		socket.once('end', () => resolveResponse(Buffer.concat(chunks).toString('utf8')));
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(pipe, resolve);
	});
	let responseTimer: ReturnType<typeof setTimeout>;
	const boundedResponse = Promise.race([
		response,
		new Promise<never>((_, reject) => {
			responseTimer = setTimeout(() => reject(new Error('network helper response timed out')), HELPER_TIMEOUT_MS);
		}),
	]);
	try {
		const [exitCode, output] = await Promise.all([runElevatedWindowsProcess(helper, windowsHelperParameters(encoded, pipe), HELPER_TIMEOUT_MS), boundedResponse]);
		if (exitCode !== 0) throw new Error(`network helper exited with ${exitCode}`);
		return output;
	} catch (error) {
		throw new Error(error instanceof Error ? error.message.slice(0, 500) : 'network helper failed');
	} finally {
		clearTimeout(responseTimer!);
		server.close();
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
	const output = platform === 'win32' ? await runWindowsHelper(helper, encoded) : platform === 'darwin' ? await runMacHelper(helper, encoded) : await runLinuxHelper(helper, request);
	return parseNetworkHelperResponse(output);
}
