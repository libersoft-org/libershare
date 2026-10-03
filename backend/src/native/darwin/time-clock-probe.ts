import { selfProcessCommand } from '../self-process.ts';
import { DarwinClockEnvironmentError, prepareDarwinClock, readDarwinClockReference, validDarwinClock, type DarwinClockParts, type DarwinClockReference } from './time-native.ts';

export interface DarwinClockProbeRequest {
	readonly version: 1;
	readonly clock: DarwinClockParts;
	readonly reference: DarwinClockReference;
}
export interface DarwinClockProbeReply {
	readonly version: 1;
	readonly targetUtcMs: number;
	readonly reference: DarwinClockReference;
}
export interface DarwinClockConversionDeps {
	readonly reference: () => DarwinClockReference;
	readonly convert: (clock: DarwinClockParts) => number;
	readonly probe: (request: DarwinClockProbeRequest) => Promise<DarwinClockProbeReply>;
}

export function sameDarwinClockReference(left: DarwinClockReference, right: DarwinClockReference): boolean {
	return left.localDate === right.localDate && left.zoneSha256 === right.zoneSha256 && left.bootId === right.bootId;
}
function validReference(value: unknown): value is DarwinClockReference {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const reference = value as DarwinClockReference;
	return Object.keys(reference).sort().join() === 'bootId,localDate,zoneSha256' && typeof reference.localDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(reference.localDate) && typeof reference.zoneSha256 === 'string' && /^[a-f0-9]{64}$/.test(reference.zoneSha256) && typeof reference.bootId === 'string' && /^darwin-boot:[a-f0-9-]{36}$/.test(reference.bootId);
}
export function validDarwinClockProbeRequest(value: unknown): value is DarwinClockProbeRequest {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const request = value as DarwinClockProbeRequest;
	return Object.keys(request).sort().join() === 'clock,reference,version' && request.version === 1 && validDarwinClock(request.clock) && validReference(request.reference);
}
function validClockProbeInput(value: unknown): value is Pick<DarwinClockProbeRequest, 'version' | 'clock'> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const request = value as DarwinClockProbeRequest;
	return Object.keys(request).sort().join() === 'clock,version' && request.version === 1 && validDarwinClock(request.clock);
}

/** The child only uses mktime; it cannot fall back or write the system clock. */
export function evaluateDarwinClockProbe(request: DarwinClockProbeRequest, reference: () => DarwinClockReference = readDarwinClockReference, convert: (clock: DarwinClockParts) => number = prepareDarwinClock): DarwinClockProbeReply {
	if (!validDarwinClockProbeRequest(request) || !sameDarwinClockReference(request.reference, reference())) throw new Error('The clock conversion reference changed');
	const targetUtcMs = convert(request.clock);
	if (!Number.isSafeInteger(targetUtcMs) || !sameDarwinClockReference(request.reference, reference())) throw new Error('The clock conversion reference changed');
	return { version: 1, targetUtcMs, reference: request.reference };
}
export async function runDarwinClockProbeArgument(encoded: string): Promise<number> {
	if (process.platform !== 'darwin' || typeof encoded !== 'string' || encoded.length > 2048) return 3;
	let request: unknown;
	try {
		request = JSON.parse(encoded);
	} catch {
		return 3;
	}
	try {
		const reply = validDarwinClockProbeRequest(request) ? evaluateDarwinClockProbe(request) : validClockProbeInput(request) ? await prepareDarwinClockSafely(request.clock) : null;
		if (!reply) return 3;
		process.stdout.write(JSON.stringify(reply));
		return 0;
	} catch {
		return 4;
	}
}

export async function readDarwinClockProbeOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader(),
		chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			length += part.value.byteLength;
			if (length > 4096) throw new Error('The clock conversion response is too large');
			chunks.push(part.value);
		}
		return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
	} finally {
		reader.releaseLock();
	}
}
export function parseDarwinClockProbeReply(output: string, reference: DarwinClockReference): DarwinClockProbeReply {
	if (Buffer.byteLength(output) > 4096) throw new Error('The clock conversion response is too large');
	const value: unknown = JSON.parse(output);
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid clock conversion response');
	const reply = value as DarwinClockProbeReply;
	if (Object.keys(reply).sort().join() !== 'reference,targetUtcMs,version' || reply.version !== 1 || !Number.isSafeInteger(reply.targetUtcMs) || !validReference(reply.reference) || !sameDarwinClockReference(reference, reply.reference)) throw new Error('Invalid clock conversion response');
	return reply;
}

/** Worker.env cannot change libc getenv; this read-only child needs a separate C environment. */
export async function runDarwinClockProbeChild(request: DarwinClockProbeRequest): Promise<DarwinClockProbeReply> {
	const probeIndex = process.argv.indexOf('--clock-probe');
	if (!validDarwinClockProbeRequest(request) || (probeIndex !== -1 && !validClockProbeInput(JSON.parse(process.argv[probeIndex + 1] ?? 'null')))) throw new Error('Invalid recursive clock conversion request');
	const environment = { ...process.env };
	delete environment['TZ'];
	const child = Bun.spawn(selfProcessCommand('--clock-probe', JSON.stringify(request)), { env: environment, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
	let expired = false;
	const timer = setTimeout(() => {
		expired = true;
		child.kill('SIGKILL');
	}, 5000);
	try {
		const [code, output] = await Promise.all([child.exited, readDarwinClockProbeOutput(child.stdout)]);
		if (expired) throw new Error('The clock conversion probe timed out');
		if (code !== 0) throw new Error('The clock conversion probe could not establish the requested time');
		return parseDarwinClockProbeReply(output, request.reference);
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null) child.kill('SIGKILL');
		await child.exited;
	}
}

export async function prepareDarwinClockSafely(clock: DarwinClockParts, supplied?: DarwinClockConversionDeps): Promise<DarwinClockProbeReply> {
	if (!validDarwinClock(clock)) throw new Error('Invalid clock time');
	const deps = supplied ?? { reference: readDarwinClockReference, convert: prepareDarwinClock, probe: runDarwinClockProbeChild };
	const reference = deps.reference();
	let reply: DarwinClockProbeReply;
	try {
		reply = { version: 1, targetUtcMs: deps.convert(clock), reference };
	} catch (error) {
		if (!(error instanceof DarwinClockEnvironmentError)) throw error;
		reply = await deps.probe({ version: 1, clock, reference });
	}
	if (!Number.isSafeInteger(reply.targetUtcMs) || !sameDarwinClockReference(reference, reply.reference) || !sameDarwinClockReference(reference, deps.reference())) throw new Error('The host date, boot or timezone changed during clock conversion');
	return reply;
}
