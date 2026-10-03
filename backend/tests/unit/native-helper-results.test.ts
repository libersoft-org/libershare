import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, lstat, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { decodeNetworkHelperRequest, encodeNetworkHelperRequest, type NetworkHelperRequest } from '../../src/network-helper-protocol.ts';
import { HelperResultStore, createHelperCancellation, helperResultCanExpire, helperRequestHash, trustedUnixHelperResult, validateHelperResult, type HelperResultRecord, type HelperResultSecurity } from '../../src/native/helper-results-store.ts';
import { observeHelperOperation, readTrustedHelperResult, type HelperOperationRule, type HelperObservationDeps } from '../../src/native/helper-results.ts';
import { executeRecordedHelper, type HelperExecutorDeps } from '../../src/native/helper-results-executor.ts';
import { requireNativeMutationContext } from '../../src/native/mutation-context.ts';
import { trustedHelperAcl } from '../../src/native/helper-results-windows.ts';
import { NativeWorkerFailure } from '../../src/native/worker-host.ts';

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const boot = 'linux-boot:12345678-1234-4321-8123-123456789abc';
function request(id: string = randomUUID()): NetworkHelperRequest {
	return { version: 2, operationId: id, cancelPath: resolve(tmpdir(), `${id}.cancel`), operation: 'applyIPv4', interfaceID: 'eth-test', config: { mode: 'dhcp' }, expected: { mode: 'dhcp', address: null, prefixLength: null, gateway: null, dns: [] } };
}
function record(input: NetworkHelperRequest = request()): HelperResultRecord {
	return { version: 2, helperVersion: 2, operationId: input.operationId, requestHash: helperRequestHash(input), pid: 123, processStart: 'linux-starttime:456', bootId: boot, domain: 'network', createdAt: 1000, updatedAt: 1000, phase: 'started', executorReturned: false, endRule: { kind: 'boot' } };
}

// These filesystem tests inject ownership only; native ownership and ACL checks have separate live probes.
async function fixture() {
	const base = await mkdtemp(join(tmpdir(), 'helper-results-'));
	directories.push(base);
	let deny = false;
	const security: HelperResultSecurity = {
		verify: async (path, directory) => {
			const info = await lstat(path);
			if (deny || info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw Object.assign(new Error('denied'), { code: 'EACCES' });
		},
		createDirectory: async path => {
			try {
				await mkdir(path, { mode: 0o755 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			}
		},
		writeNew: async (path, text) => {
			const h = await open(path, 'wx', 0o600);
			try {
				await h.writeFile(text);
				await h.sync();
			} finally {
				await h.close();
			}
		},
	};
	const store = new HelperResultStore(join(base, 'private', 'helper-results'), security);
	const input = { ...request(), cancelPath: join(base, 'cancel') };
	const obs: HelperObservationDeps = { read: id => store.read(id), cancel: createHelperCancellation, bootId: () => boot, process: identity => ({ identity, state: 'ended' }), busId: async () => null };
	const deps: HelperExecutorDeps = {
		store,
		identity: () => ({ pid: 123, started: 'linux-starttime:456' }),
		bootId: () => boot,
		cancelExists: async path => {
			try {
				await lstat(path);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
				throw error;
			}
		},
		lock: async (_path, action) => action(),
		observation: obs,
	};
	return {
		base,
		store,
		input,
		obs,
		deps,
		deny: () => {
			deny = true;
		},
	};
}

describe('helper protocol v2', () => {
	test('requires UUID4, an absolute marker path and version2', () => {
		const input = request();
		expect(decodeNetworkHelperRequest(encodeNetworkHelperRequest(input))).toEqual(input);
		for (const patch of [{ version: 1 }, { version: 3 }, { operationId: '../request' }, { operationId: '00000000-0000-1000-8000-000000000000' }, { cancelPath: 'relative' }, { cancelPath: 'bad\0path' }, { unexpected: true }]) expect(() => decodeNetworkHelperRequest(Buffer.from(JSON.stringify({ ...input, ...patch })).toString('base64url'))).toThrow();
	});
	test('rejects a v1 request through the actual helper entrypoint', async () => {
		const encoded = Buffer.from(JSON.stringify({ ...request(), version: 1 })).toString('base64url');
		const child = Bun.spawn([process.execPath, 'src/network-helper.ts', '--request', encoded], { cwd: resolve(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe' });
		const output = await new Response(child.stdout).text();
		await child.exited;
		expect(JSON.parse(output)).toMatchObject({ ok: false, error: 'unsupported network helper version' });
	});
});

describe('privileged result storage', () => {
	test('recovery binds an old receipt to its original boot and request hash', async () => {
		const f = await fixture();
		const original = { ...record(f.input), recoveryData: { snapshot: 'original-policy' } };
		await f.store.start(original);
		const identity = { operationId: original.operationId, requestHash: original.requestHash, expectedBootId: boot };
		expect((await readTrustedHelperResult(identity, f.store))?.recoveryData).toEqual(original.recoveryData);
		await expect(readTrustedHelperResult({ ...identity, expectedBootId: 'wrong-boot' }, f.store)).rejects.toThrow('does not match');
		await expect(readTrustedHelperResult({ ...identity, requestHash: 'a'.repeat(64) }, f.store)).rejects.toThrow('does not match');
		await expect(readTrustedHelperResult({ operationId: original.operationId, requestHash: original.requestHash }, f.store)).rejects.toThrow('does not match');
	});
	test('publishes complete records and refuses reuse of an operation ID', async () => {
		const f = await fixture(),
			original = record(f.input);
		await f.store.start(original);
		expect(await f.store.read(original.operationId)).toEqual(original);
		await expect(f.store.start(original)).rejects.toThrow('claimed');
		const finished: HelperResultRecord = { ...original, phase: 'finished', executorReturned: true, result: { outcome: 'known', response: { ok: true } } };
		await f.store.write(finished);
		expect(await f.store.read(original.operationId)).toEqual(finished);
	});
	test('does not turn inaccessible or corrupt records into missing records', async () => {
		const f = await fixture();
		await f.store.start(record(f.input));
		await writeFile(join(f.store.directory, `${f.input.operationId}.json`), 'partial');
		await expect(f.store.read(f.input.operationId)).rejects.toThrow();
		f.deny();
		await expect(f.store.read(f.input.operationId)).rejects.toThrow('denied');
	});
	test('keeps started and finished-unknown records regardless of age', async () => {
		const f = await fixture(),
			started = record(f.input),
			unknown = { ...record(request()), phase: 'finished' as const, result: { outcome: 'unknown' as const } },
			known = { ...record(request()), phase: 'finished' as const, result: { outcome: 'known' as const, response: { ok: true as const } } };
		await f.store.start(started);
		await f.store.write(unknown);
		await f.store.write(known);
		await f.store.cleanup(boot, 1000 + 8 * 86400000);
		expect(await f.store.read(started.operationId)).not.toBeNull();
		expect(await f.store.read(unknown.operationId)).not.toBeNull();
		expect(await f.store.read(known.operationId)).toBeNull();
		expect(helperResultCanExpire(unknown, 'another-boot', 1001)).toBe(true);
		expect(helperResultCanExpire(unknown, null, 1e15)).toBe(false);
	});
	test('rejects unexpected schema fields and incomplete finished outcomes', () => {
		for (const patch of [{ phase: 'finished' }, { helperVersion: 1 }, { pid: 0 }, { requestHash: 'x' }, { command: 'run' }, { result: { outcome: 'unknown' } }]) expect(() => validateHelperResult({ ...record(), ...patch })).toThrow();
	});
	test('requires privileged ownership and denies foreign write, delete and ACL rights', () => {
		expect(trustedUnixHelperResult(0, 0o100644)).toBe(true);
		expect(trustedUnixHelperResult(1, 0o100644)).toBe(false);
		expect(trustedUnixHelperResult(0, 0o100664)).toBe(false);
		const read = { type: 0, mask: 0x120089, sid: 'S-1-5-32-545' };
		expect(trustedHelperAcl('S-1-5-18', [read], true)).toBe(true);
		expect(trustedHelperAcl('S-1-5-21-1', [read], true)).toBe(false);
		expect(trustedHelperAcl('S-1-5-18', [], false)).toBe(false);
		for (const mask of [2, 4, 0x40, 0x10000, 0x40000, 0x80000, 0x10000000, 0x40000000]) expect(trustedHelperAcl('S-1-5-18', [{ ...read, mask }], true)).toBe(false);
	});
});

describe('helper handoff and recovery', () => {
	const rule = (input: NetworkHelperRequest): HelperOperationRule => ({ kind: 'helper', operationId: input.operationId, requestHash: helperRequestHash(input), cancelPath: input.cancelPath, launcher: { pid: 1, started: 'linux-starttime:1' } });
	test('writes cancellation before deciding that started is absent', async () => {
		const f = await fixture(),
			order: string[] = [];
		const observed = await observeHelperOperation(rule(f.input), {
			...f.obs,
			cancel: async () => {
				order.push('cancel');
			},
			read: async () => {
				order.push('read');
				return null;
			},
		});
		expect(observed.state).toBe('ended');
		expect(order).toEqual(['cancel', 'read']);
	});
	test('keeps a live or unreadable launcher pending when there is no receipt', async () => {
		const f = await fixture();
		for (const state of ['running', 'unknown'] as const) {
			let cancelled = false;
			const value = await observeHelperOperation(rule(f.input), {
				...f.obs,
				process: identity => ({ identity, state }),
				cancel: async () => {
					cancelled = true;
				},
			});
			expect(value.state).toBe(state === 'running' ? 'pending' : 'unknown');
			expect(cancelled).toBe(false);
		}
	});
	test('a durable explicit cancellation wins even while the authorization prompt lives', async () => {
		const f = await fixture();
		await createHelperCancellation(f.input.cancelPath);
		const value = await observeHelperOperation(rule(f.input), { ...f.obs, process: identity => ({ identity, state: 'running' }), cancelled: async () => true });
		expect(value.state).toBe('ended');
	});
	test('ignores a stale, foreign or unreadable receipt', async () => {
		const f = await fixture();
		await f.store.start(record(f.input));
		for (const patch of [{ requestHash: 'f'.repeat(64) }, { bootId: 'other' }, { helperVersion: 1 }]) {
			const original = record(f.input);
			await writeFile(join(f.store.directory, `${f.input.operationId}.json`), JSON.stringify({ ...original, ...patch }));
			expect((await observeHelperOperation(rule(f.input), f.obs)).state).toBe('unknown');
		}
		f.deny();
		expect((await observeHelperOperation(rule(f.input), f.obs)).state).toBe('unknown');
	});
	test('does not release finished-unknown just because the helper exited', async () => {
		const f = await fixture(),
			value: HelperResultRecord = { ...record(f.input), phase: 'finished', executorReturned: true, result: { outcome: 'unknown' } };
		await f.store.prepare();
		await f.store.write(value);
		expect((await observeHelperOperation(rule(f.input), f.obs)).state).toBe('pending');
	});
	test('a helper arriving after cancellation cannot invoke the operation', async () => {
		const f = await fixture();
		await createHelperCancellation(f.input.cancelPath);
		let called = false;
		await executeRecordedHelper(
			f.input,
			helperRequestHash(f.input),
			async () => {
				called = true;
				return { ok: true };
			},
			10000,
			f.deps
		);
		expect(called).toBe(false);
		expect((await f.store.read(f.input.operationId))?.phase).toBe('cancelled');
	});
	test('an expired consent delay never starts the requested operation', async () => {
		const f = await fixture();
		let called = false;
		const input = { ...f.input, deadlineUptime: 99 };
		await executeRecordedHelper(
			input,
			helperRequestHash(input),
			async () => {
				called = true;
				return { ok: true };
			},
			10000,
			{ ...f.deps, uptime: () => 100 }
		);
		expect(called).toBe(false);
		expect((await f.store.read(input.operationId))?.result?.outcome).toBe('known');
	});
	test('lets an active call return after its deadline but refuses the next write', async () => {
		const f = await fixture();
		let clock = 0,
			writes = 0;
		await executeRecordedHelper(
			f.input,
			helperRequestHash(f.input),
			async () => {
				const context = requireNativeMutationContext();
				await context.call({ kind: 'executor' }, async () => {
					writes++;
					clock = 1000;
					return { known: true, value: null };
				});
				await context.call({ kind: 'executor' }, async () => {
					writes++;
					return { known: true, value: null };
				});
				return { ok: true };
			},
			500,
			{ ...f.deps, clock: () => clock }
		);
		expect(writes).toBe(1);
		expect((await f.store.read(f.input.operationId))?.result?.outcome).toBe('known');
	});
	test('started wins the race and retains ownership while a native call is blocked', async () => {
		const f = await fixture();
		let finish!: () => void, started!: () => void;
		const began = new Promise<void>(resolve => {
			started = resolve;
		});
		const pending = new Promise<void>(resolve => {
			finish = resolve;
		});
		const execution = executeRecordedHelper(
			f.input,
			helperRequestHash(f.input),
			async () => {
				await requireNativeMutationContext().call({ kind: 'boot' }, async () => {
					started();
					await pending;
					return { known: false };
				});
				return { ok: true };
			},
			10000,
			f.deps
		);
		await began;
		await createHelperCancellation(f.input.cancelPath);
		const alive = { ...f.obs, process: (identity: Parameters<HelperObservationDeps['process']>[0]) => ({ identity, state: 'running' as const }) };
		expect((await observeHelperOperation({ ...rule(f.input), launcher: null }, alive)).state).toBe('pending');
		await f.store.cleanup(boot, Date.now() + 8 * 86400000);
		expect(await f.store.read(f.input.operationId)).not.toBeNull();
		finish();
		await execution;
		expect((await f.store.read(f.input.operationId))?.result?.outcome).toBe('unknown');
	});
	test('a lost worker response cannot claim that the executor returned', async () => {
		const f = await fixture();
		await executeRecordedHelper(
			f.input,
			helperRequestHash(f.input),
			async () => {
				await requireNativeMutationContext().call({ kind: 'executor' }, async () => {
					throw new NativeWorkerFailure('lost response', true);
				});
				return { ok: true };
			},
			10000,
			f.deps
		);
		const receipt = await f.store.read(f.input.operationId);
		expect(receipt?.result?.outcome).toBe('unknown');
		expect(receipt?.executorReturned).toBe(false);
		expect((await observeHelperOperation(rule(f.input), { ...f.obs, process: identity => ({ identity, state: 'running' }) })).state).toBe('pending');
	});
	test('untracked legacy work records boot-only recovery before it starts', async () => {
		const f = await fixture();
		await executeRecordedHelper(
			f.input,
			helperRequestHash(f.input),
			async () => {
				expect((await f.store.read(f.input.operationId))?.endRule).toEqual({ kind: 'boot' });
				return { ok: true };
			},
			10000,
			f.deps
		);
		expect((await f.store.read(f.input.operationId))?.result?.outcome).toBe('unknown');
	});
	test('records native ownership before invoking a write and publishes the known result', async () => {
		const f = await fixture();
		const recovery = { time: { clock: { targetUtcMs: 123456789, hostUptimeMs: 1000, bootId: boot } } };
		await executeRecordedHelper(
			f.input,
			helperRequestHash(f.input),
			async () => {
				await requireNativeMutationContext().recordRecovery(recovery);
				await requireNativeMutationContext().call({ kind: 'executor' }, async () => {
					const stored = await f.store.readActive('network');
					expect(stored?.executorReturned).toBe(false);
					expect(stored?.operationId).toBe(f.input.operationId);
					expect(stored?.recoveryData).toEqual(recovery);
					return { known: true, value: null };
				});
				return { ok: true };
			},
			10000,
			f.deps
		);
		expect((await f.store.read(f.input.operationId))?.result).toEqual({ outcome: 'known', response: { ok: true } });
		expect((await observeHelperOperation(rule(f.input), f.obs)).state).toBe('ended');
	});
	test('serializes concurrent recovery updates and retains execution metadata', async () => {
		const f = await fixture();
		const write = f.store.write.bind(f.store);
		let activeWrites = 0,
			maximumWrites = 0;
		f.store.write = async value => {
			activeWrites++;
			maximumWrites = Math.max(maximumWrites, activeWrites);
			try {
				await write(value);
			} finally {
				activeWrites--;
			}
		};
		await executeRecordedHelper(
			f.input,
			helperRequestHash(f.input),
			async () => {
				const context = requireNativeMutationContext();
				await Promise.all([context.recordRecovery({ before: 'original' }), context.recordRecovery({ target: 'requested' })]);
				await context.call({ kind: 'executor' }, async () => {
					await Promise.all([context.recordExecution({ kind: 'executor' }, { first: 1 }), context.recordExecution({ kind: 'executor' }, { second: 2 })]);
					return { known: true, value: null };
				});
				return { ok: true };
			},
			10000,
			f.deps
		);
		const receipt = await f.store.read(f.input.operationId);
		expect(maximumWrites).toBe(1);
		expect(receipt?.recoveryData).toEqual({ before: 'original', target: 'requested', first: 1, second: 2 });
		expect(receipt?.executorReturned).toBe(true);
		expect(receipt?.result?.outcome).toBe('known');
	});
});
