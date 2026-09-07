import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface LifecycleResult {
	error: string | null;
	elapsed: number;
	mutationBlocked: boolean;
	createdAtTimeout: number;
	createdAfterNext: number;
	nextError: string | null;
	recovered: unknown;
	mutationRecovered: boolean;
	entered: number;
	lateAssociation: number;
	resultWasUndefined: boolean;
}

function scenario(mode: string, ignoreTerminate = false): LifecycleResult {
	const fixture = pathToFileURL(resolve(import.meta.dir, '../helpers/corewlan-lifecycle-worker.js')).href;
	const module = pathToFileURL(resolve(import.meta.dir, '../../src/system-network-corewlan.ts')).href;
	const script = `
		const NativeWorker = Worker;
		const marker = new Int32Array(new SharedArrayBuffer(8));
		let created = 0;
		let closed;
		const firstClosed = new Promise(resolve => closed = resolve);
		globalThis.Worker = class extends NativeWorker {
			constructor() {
				super(${JSON.stringify(fixture)});
				this.index = ++created;
				if (this.index === 1) this.addEventListener('close', closed);
			}
			postMessage(request) {
				if (this.index === 1 && ${JSON.stringify(mode)} === 'post-error') throw new Error('Cannot clone');
				super.postMessage({ ...request, marker, mode: this.index === 1 ? ${JSON.stringify(mode)} : 'success' });
			}
			terminate() {
				if (this.index === 1 && ${ignoreTerminate}) return;
				super.terminate();
			}
		};
		const timer = globalThis.setTimeout;
		globalThis.setTimeout = (callback, delay, ...args) => timer(callback, delay === 20000 || delay === 45000 ? 120 : delay, ...args);
		const { readCoreWlanWifi, associateMacWifi, disconnectCoreWlanWifi, assertMacWifiMutationIdle } = await import(${JSON.stringify(module)});
		const associate = ${JSON.stringify(mode)} === 'in-flight' || ${JSON.stringify(mode)} === 'late-associate';
		const started = performance.now();
		let error = null, operationResult;
		try {
			if (${JSON.stringify(mode)}.startsWith('disconnect-') || ${JSON.stringify(mode)} === 'late-disconnect') operationResult = await disconnectCoreWlanWifi('en0');
			else if (associate) await associateMacWifi('en0', 'Example', 'example-password', 'WPA2');
			else await readCoreWlanWifi();
		} catch (failure) { error = failure.message; }
		const elapsed = performance.now() - started;
		let mutationBlocked = false;
		try { assertMacWifiMutationIdle(); } catch { mutationBlocked = true; }
		const createdAtTimeout = created;
		let nextError = null;
		try { await readCoreWlanWifi(); } catch (failure) { nextError = failure.message; }
		const createdAfterNext = created;
		await firstClosed;
		const recovered = await readCoreWlanWifi();
		let mutationRecovered = true;
		try { assertMacWifiMutationIdle(); } catch { mutationRecovered = false; }
		console.log('RESULT:' + JSON.stringify({ error, elapsed, mutationBlocked, createdAtTimeout, createdAfterNext, nextError, recovered, mutationRecovered, entered: marker[0], lateAssociation: marker[1], resultWasUndefined: operationResult === undefined }));
	`;
	const child = Bun.spawnSync([process.execPath, '--eval', script], { timeout: 5_000 });
	if (child.exitCode !== 0) throw new Error(child.stderr.toString());
	const result = child.stdout
		.toString()
		.split(/\r?\n/)
		.find(line => line.startsWith('RESULT:'));
	expect(result).toBeDefined();
	return JSON.parse(result!.slice(7));
}

describe('CoreWLAN worker deadlines and native lifetime', () => {
	it('finishes a nonresponding worker request and permits recovery after close', () => {
		const result = scenario('silent');
		expect(result.error).toContain('timed out');
		expect(result.elapsed).toBeLessThan(1000);
		expect(result.recovered).toEqual([]);
	});

	it('quarantines a blocked native read without blocking IPv4 changes', () => {
		const result = scenario('read-block');
		expect(result.entered).toBe(1);
		expect(result.error).toContain('timed out');
		expect(result.mutationBlocked).toBe(false);
		expect(result.nextError).toContain('still finishing');
		expect(result.createdAfterNext).toBe(result.createdAtTimeout);
		expect(result.mutationRecovered).toBe(true);
	});

	it('prevents late association even if worker termination cannot stop execution', () => {
		const result = scenario('late-associate', true);
		expect(result.error).toContain('before any network change');
		expect(result.lateAssociation).toBe(-1);
		expect(result.mutationBlocked).toBe(false);
		expect(result.nextError).toContain('still finishing');
	});

	it('reports an in-flight association as unknown and blocks mutations until close', () => {
		const result = scenario('in-flight');
		expect(result.error).toContain('result is unknown');
		expect(result.mutationBlocked).toBe(true);
		expect(result.nextError).toContain('still finishing');
		expect(result.createdAfterNext).toBe(1);
		expect(result.mutationRecovered).toBe(true);
	});

	it('blocks a late disconnect after the request deadline', () => {
		const result = scenario('late-disconnect', true);
		expect(result.error).toContain('before any network change');
		expect(result.lateAssociation).toBe(-1);
		expect(result.mutationBlocked).toBe(false);
		expect(result.nextError).toContain('still finishing');
	});

	it('reports a timed-out disconnect as unknown until the native write closes', () => {
		const result = scenario('disconnect-in-flight');
		expect(result.error).toContain('disconnect timed out; its result is unknown');
		expect(result.error).not.toContain('association');
		expect(result.mutationBlocked).toBe(true);
		expect(result.createdAfterNext).toBe(1);
		expect(result.mutationRecovered).toBe(true);
	});

	it('accepts the undefined disconnect result and releases the slot before resolving', () => {
		const result = scenario('disconnect-success');
		expect(result.error).toBeNull();
		expect(result.resultWasUndefined).toBe(true);
		expect(result.nextError).toBeNull();
		expect(result.createdAfterNext).toBe(2);
	});

	it('keeps the deadline active when a message arrives but the worker cannot close', () => {
		const result = scenario('message-before-close', true);
		expect(result.error).toContain('timed out');
		expect(result.recovered).toEqual([]);
	});

	it.each(['success', 'error', 'empty-close', 'post-error'])('releases the slot before settling %s', mode => {
		const result = scenario(mode);
		expect(result.error).toEqual(mode === 'success' ? null : expect.any(String));
		expect(result.nextError).toBeNull();
		expect(result.createdAfterNext).toBe(2);
		expect(result.recovered).toEqual([]);
	});
});
