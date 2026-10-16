import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CodedError, ErrorCodes } from '@shared';

const EXE = process.platform === 'win32' ? 'lish-overlay.exe' : 'lish-overlay';
/** One-shot commands (keys, certificates) finish in milliseconds; anything slower is a stuck helper. */
const COMMAND_TIMEOUT_MS = 30_000;

/**
 * The `lish-overlay` helper: `LISH_OVERLAY_BIN` when set, else next to the backend executable (installed builds),
 * else the repository's `overlay/build/` (running from source).
 */
export function overlayBinaryPath(): string {
	const candidates = [process.env['LISH_OVERLAY_BIN'], join(dirname(process.execPath), EXE), join(import.meta.dir, '..', '..', '..', 'overlay', 'build', EXE)];
	for (const path of candidates) if (path && existsSync(path)) return path;
	throw new CodedError(ErrorCodes.OVERLAY_HELPER_UNAVAILABLE, `${EXE} not found next to the backend`);
}

/** A certificate as `lish-overlay` describes it. */
export interface CertificateInfo {
	cert: string;
	name: string;
	networks: string[];
	groups: string[];
	isCA: boolean;
	notBefore: string;
	notAfter: string;
	issuer: string;
	fingerprint: string;
	publicKey: string;
}

/**
 * Run a one-shot helper command and parse the one JSON object it prints. A failure carries the helper's own
 * message, which never contains key material (the helper reads keys from files and prints public data only).
 */
export async function runOverlayCommand<T>(args: string[], code: (typeof ErrorCodes)[keyof typeof ErrorCodes] = ErrorCodes.OVERLAY_CERTIFICATE_INVALID): Promise<T> {
	const proc = Bun.spawn([overlayBinaryPath(), ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
	const timer = setTimeout(() => proc.kill(), COMMAND_TIMEOUT_MS);
	try {
		const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		if (exit !== 0) throw new CodedError(code, stderr.trim().replace(/^lish-overlay: /, '') || `lish-overlay ${args[0]} exited with ${exit}`);
		return JSON.parse(stdout) as T;
	} finally {
		clearTimeout(timer);
	}
}
