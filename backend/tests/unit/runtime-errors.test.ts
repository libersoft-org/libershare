import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

/** Trigger the real process boundary outside Bun's test runner error listeners. */
function runWithErrorHandlers(kind: 'exception' | 'rejection', error: string, count = 1) {
	const script = `
		import { installRuntimeErrorHandlers } from './src/runtime-errors.ts';
		installRuntimeErrorHandlers();
		for (let index = 0; index < ${count}; index++) {
			setTimeout(() => {
				const error = ${error};
				${kind === 'exception' ? 'throw error;' : 'void Promise.reject(error);'}
			}, 0);
		}
		setTimeout(() => { console.log('BOUNDARY_SURVIVED'); process.exit(0); }, 50);
	`;
	return Bun.spawnSync([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../..'), timeout: 5000 });
}

describe('production runtime error handlers', () => {
	it('survives an actual uncaught Error named AbortError and logs its name', () => {
		const result = runWithErrorHandlers('exception', "Object.assign(new Error('cancelled'), { name: 'AbortError' })");
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain('BOUNDARY_SURVIVED');
		expect(result.stderr.toString()).toContain('Suppressed transient libp2p error (AbortError): cancelled');
		expect(result.stderr.toString()).not.toContain('[FATAL]');
	});

	it('survives an actual rejected DOMException named TimeoutError', () => {
		const result = runWithErrorHandlers('rejection', "new DOMException('timed out', 'TimeoutError')");
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain('BOUNDARY_SURVIVED');
		expect(result.stderr.toString()).toContain('Suppressed transient libp2p rejection (TimeoutError): timed out');
		expect(result.stderr.toString()).not.toContain('[FATAL]');
	});

	it('exits with status 1 for an actual uncaught ordinary error', () => {
		const result = runWithErrorHandlers('exception', "new Error('ordinary failure')");
		expect(result.exitCode).toBe(1);
		expect(result.stdout.toString()).not.toContain('BOUNDARY_SURVIVED');
		expect(result.stderr.toString()).toContain('[FATAL] Uncaught exception: ctor=Error name=Error msg=ordinary failure');
	});

	it('exits with status 1 for an actual rejected TypeError', () => {
		const result = runWithErrorHandlers('rejection', "new TypeError('invalid input')");
		expect(result.exitCode).toBe(1);
		expect(result.stdout.toString()).not.toContain('BOUNDARY_SURVIVED');
		expect(result.stderr.toString()).toContain('[FATAL] Unhandled rejection: ctor=TypeError name=TypeError msg=invalid input');
	});

	it('rate-limits repeated transient errors without terminating the process', () => {
		const result = runWithErrorHandlers('exception', "Object.assign(new Error('cancelled'), { name: 'AbortError' })", 3);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain('BOUNDARY_SURVIVED');
		expect(result.stderr.toString().match(/Suppressed transient libp2p error/g)).toHaveLength(1);
	});
});
