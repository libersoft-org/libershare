import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { setTimeout as scheduleTimeout, clearTimeout as cancelTimeout } from 'node:timers';

interface Result {
	rejected: { name: string; message: string; code: string | null } | null;
	uncaught: { name: string; message: string; code: string | null }[];
	initialSockets: { closed: boolean; destroyed: boolean; errorListeners: number }[];
	initialErrorListeners: number | null;
	consumerError: string | null;
	echo: string | null;
	recoveryEcho: string | null;
	recoverySocket: { closed: boolean; destroyed: boolean; errorListeners: number } | null;
	serverErrors: string[];
}

async function runChild(mode: string, expectedExit = 0): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const started = performance.now();
	const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../../helpers/tcp-abort-fixture.js'), mode], { cwd: resolve(import.meta.dir, '../../..'), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
	let timedOut = false;
	const timeout = scheduleTimeout(() => {
		timedOut = true;
		child.kill('SIGKILL');
	}, 10_000);
	try {
		const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		if (exitCode !== expectedExit || timedOut) {
			const error = (child as typeof child & { error?: unknown }).error;
			throw new Error(
				`TCP subprocess failed: ${JSON.stringify({
					mode,
					expectedExit,
					exitCode,
					signalCode: child.signalCode ?? null,
					timedOut,
					elapsedMs: Math.round(performance.now() - started),
					executable: process.execPath,
					spawnMocked: 'mock' in Bun.spawn,
					error: error instanceof Error ? { name: error.name, message: error.message, code: Reflect.get(error, 'code'), stack: error.stack } : (error ?? null),
					stdout,
					stderr,
				})}`
			);
		}
		return { exitCode, stdout, stderr };
	} finally {
		cancelTimeout(timeout);
		if (child.exitCode === null) {
			child.kill('SIGKILL');
			await child.exited;
		}
	}
}

async function scenario(mode: string, warningName?: string): Promise<Result> {
	const child = await runChild(mode);
	expect(child.exitCode).toBe(0);
	const stderr = child.stderr.toString();
	if (warningName) {
		expect(stderr).toContain('[WARN] Suppressed transient libp2p error');
		expect(stderr).toContain(warningName);
		expect(stderr).not.toContain('[FATAL]');
	} else expect(stderr).toBe('');
	const line = child.stdout
		.toString()
		.split(/\r?\n/)
		.find(value => value.startsWith('RESULT:'));
	expect(line).toBeDefined();
	const result: Result = JSON.parse(line!.slice(7));
	expect(result.serverErrors).toEqual([]);
	return result;
}

describe('real libp2p TCP socket abort lifecycle', () => {
	it.each(['timeout', 'cancel'])('keeps the process alive and logs the late native socket error after %s', async mode => {
		const name = mode === 'timeout' ? 'TimeoutError' : 'AbortError';
		const result = await scenario(mode, name);
		expect(result.rejected?.name).toBe('AbortError');
		expect(result.uncaught).toHaveLength(1);
		expect(result.uncaught[0]?.message).toContain(name);
		expect(result.initialSockets).toEqual([{ closed: true, destroyed: true, errorListeners: 0 }]);
		expect(result.recoveryEcho).toBe('connection after cancellation');
		expect(result.recoverySocket).toEqual({ closed: true, destroyed: true, errorListeners: 0 });
	});

	it('rejects an already-aborted combined signal before opening a socket', async () => {
		const result = await scenario('pre-aborted');
		expect(result.rejected?.name).toBe('TimeoutError');
		expect(result.uncaught).toEqual([]);
		expect(result.initialSockets).toEqual([]);
		expect(result.recoveryEcho).toBe('connection after cancellation');
		expect(result.recoverySocket).toEqual({ closed: true, destroyed: true, errorListeners: 0 });
	});

	it('rejects a real refused connection and removes the terminal error listener on close', async () => {
		const result = await scenario('refused');
		expect(result.rejected?.code).toBe('ECONNREFUSED');
		expect(result.uncaught).toEqual([]);
		expect(result.initialSockets).toEqual([{ closed: true, destroyed: true, errorListeners: 0 }]);
	});

	it('hands a connected socket to its caller without retaining the dial error listener', async () => {
		const result = await scenario('success');
		expect(result.rejected).toBeNull();
		expect(result.initialErrorListeners).toBe(0);
		expect(result.uncaught).toEqual([]);
		expect(result.echo).toBe('actual TCP echo');
		expect(result.initialSockets).toEqual([{ closed: true, destroyed: true, errorListeners: 0 }]);
	});

	it('delivers an established connection error to the caller unchanged', async () => {
		const result = await scenario('established-error');
		expect(result.rejected).toBeNull();
		expect(result.initialErrorListeners).toBe(0);
		expect(result.consumerError).toBe('established socket failure');
		expect(result.uncaught).toEqual([]);
		expect(result.initialSockets).toEqual([{ closed: true, destroyed: true, errorListeners: 0 }]);
	});

	it('exits for an unknown established socket error without a caller error listener', async () => {
		const child = await runChild('unowned-established-error', 1);
		expect(child.exitCode).toBe(1);
		expect(child.stderr.toString()).toContain('[FATAL] Uncaught exception');
		expect(child.stderr.toString()).toContain('unowned established socket failure');
		expect(child.stderr.toString()).not.toContain('[WARN] Suppressed');
		expect(child.stdout.toString()).not.toContain('RESULT:');
	});
});
