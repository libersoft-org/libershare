import { FFIType } from 'bun:ffi';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { uptime } from 'node:os';
import { networkHelperFailure, type NetworkHelperRequest, type NetworkHelperResponse } from '../network-helper-protocol.ts';
import { loadSystemLibrary } from './library.ts';
import { withWindowsHelperLock } from './helper-results-windows.ts';
import { HelperResultStore, helperCancellationExists, type HelperResultRecord } from './helper-results-store.ts';
import { helperRecordHasEnded, nativeHelperObservationDeps, type HelperObservationDeps } from './helper-results.ts';
import { currentNativeProcessIdentity, getNativeBootId } from './process-identity.ts';
import { dispatchDeadlinePassed, withNativeMutationContext } from './mutation-context.ts';
import { NativeMutationStopped, NativeMutationUnknown, type NativeMutationContext } from './mutation-host.ts';
import type { NativeEndRule, NativeProcessIdentity } from './mutation-proof.ts';

export async function withHelperDomainLock<T>(path: string, action: () => Promise<T>): Promise<T> {
	if (process.platform === 'win32') return withWindowsHelperLock(path, action);
	const handle = await open(path, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
	try {
		const library = loadSystemLibrary(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } } as const);
		try {
			const info = await lstat(path);
			if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error('Untrusted helper mutation lock');
			if (library.symbols.flock(handle.fd, 6) !== 0) throw new Error('Another privileged helper owns this mutation');
			try {
				return await action();
			} finally {
				library.symbols.flock(handle.fd, 8);
			}
		} finally {
			library.close();
		}
	} finally {
		await handle.close();
	}
}

export interface HelperExecutorDeps {
	readonly store: HelperResultStore;
	readonly identity: () => NativeProcessIdentity;
	readonly bootId: () => string | null;
	readonly cancelExists: (path: string) => Promise<boolean>;
	readonly lock: <T>(path: string, action: () => Promise<T>) => Promise<T>;
	readonly observation: HelperObservationDeps;
	readonly uptime?: () => number;
	readonly clock?: () => number;
}

function executorDeps(): HelperExecutorDeps {
	return { store: new HelperResultStore(), identity: currentNativeProcessIdentity, bootId: getNativeBootId, cancelExists: helperCancellationExists, lock: withHelperDomainLock, observation: nativeHelperObservationDeps() };
}

function knownRefusal(response: NetworkHelperResponse): boolean {
	if (!response.ok) return response.code === 'NETCONFIG_INVALID' || response.code === 'NETCONFIG_STALE' || response.code === 'NETCONFIG_UNSUPPORTED';
	return 'time' in response && !response.time.success && !response.time.changed && !response.time.stateMayHaveChanged;
}

/**
 * Run one privileged request and persist its outcome. `allWritesTracked` is the caller's promise
 * that `execute` changes the system only through `context.call`: then an end with no tracked call
 * provably sent nothing, so a failed preparation stays a known refusal instead of locking the
 * domain until reboot. Without that promise any untracked end remains unknown.
 */
export async function executeRecordedHelper(request: NetworkHelperRequest, requestHash: string, execute: () => Promise<NetworkHelperResponse>, budgetMs: number, supplied?: HelperExecutorDeps, allWritesTracked = false): Promise<NetworkHelperResponse> {
	const deps = supplied ?? executorDeps(),
		store = deps.store,
		identity = deps.identity(),
		bootId = deps.bootId(),
		at = Date.now();
	if (!bootId) throw new Error('Cannot establish boot identity for the privileged helper');
	const clock = deps.clock ?? (() => performance.now());
	const allowance = Math.min(budgetMs, request.deadlineUptime === undefined ? budgetMs : Math.max(0, (request.deadlineUptime - (deps.uptime ?? uptime)()) * 1000));
	const deadline = clock() + Math.max(0, allowance);
	let record: HelperResultRecord = { version: 2, helperVersion: 2, operationId: request.operationId, requestHash, pid: identity.pid, processStart: identity.started, bootId, domain: request.operation === 'applyIPv4' ? 'network' : 'time', createdAt: at, updatedAt: at, phase: 'started', executorReturned: false, endRule: { kind: 'executor' }, recoveryData: {} };
	await store.start(record);
	if (await deps.cancelExists(request.cancelPath)) {
		await store.write({ ...record, phase: 'cancelled', updatedAt: Date.now(), executorReturned: true });
		return { ok: false, error: 'The privileged request was cancelled before applying changes' };
	}
	if (clock() >= deadline) {
		const response: NetworkHelperResponse = { ok: false, error: 'The privileged request expired before applying changes' };
		await store.write({ ...record, phase: 'finished', executorReturned: true, updatedAt: Date.now(), result: { outcome: 'known', response } });
		return response;
	}
	let entered = false;
	try {
		return await deps.lock(join(store.directory, `${record.domain}.lock`), async () => {
			const active = await store.readActive(record.domain);
			if (active) {
				const previous = (await store.read(active.operationId)) ?? active;
				if (previous.requestHash !== active.requestHash || !(await helperRecordHasEnded(previous, deps.observation))) throw new Error('Previous privileged mutation is not finished');
			}
			await store.writeActive(record);
			entered = true;
			let unknown = false,
				inCall = false,
				tracked = false;
			let writes = Promise.resolve();
			const persist = (update: Partial<HelperResultRecord> | ((current: HelperResultRecord) => Partial<HelperResultRecord>)): Promise<void> => {
				const write = writes.then(async () => {
					const patch = typeof update === 'function' ? update(record) : update;
					const next = { ...record, ...patch, updatedAt: Date.now() };
					await store.write(next);
					await store.writeActive(next);
					record = next;
				});
				writes = write;
				return write;
			};
			const assertRule = (rule: NativeEndRule): void => {
				if (!['executor', 'boot', 'dbus-process'].includes(rule.kind)) throw new Error('A privileged helper cannot elevate recursively');
			};
			const context: NativeMutationContext = {
				operationId: request.operationId,
				dataDirectory: store.directory,
				remainingMs: () => Math.max(0, deadline - clock()),
				recordRecovery: async data => {
					if (inCall || unknown) throw new NativeMutationUnknown();
					await persist(current => ({ recoveryData: { ...current.recoveryData, ...data } }));
				},
				recordExecution: async (rule, recoveryData) => {
					assertRule(rule);
					if (!inCall || unknown) throw new NativeMutationUnknown();
					await persist(current => ({ endRule: rule, recoveryData: { ...current.recoveryData, ...recoveryData } }));
				},
				pending: async rule => {
					assertRule(rule);
					if (inCall || unknown) throw new NativeMutationUnknown();
					unknown = true;
					await persist({ endRule: rule, executorReturned: true });
					throw new NativeMutationUnknown();
				},
				call: async (rule, invoke) => {
					assertRule(rule);
					if (inCall || unknown) throw new NativeMutationUnknown();
					tracked = true;
					// The caller's own deadline counts too: a request that ran out while preparing starts no write.
					if (clock() >= deadline || dispatchDeadlinePassed()) throw new NativeMutationStopped();
					inCall = true;
					try {
						await persist({ endRule: rule, executorReturned: false });
						if (clock() >= deadline || dispatchDeadlinePassed()) throw new NativeMutationStopped();
						const answer = await invoke();
						inCall = false;
						unknown = !answer.known;
						await persist({ executorReturned: true });
						if (!answer.known) throw new NativeMutationUnknown();
						return answer.value;
					} catch (error) {
						const unsent = error instanceof NativeMutationStopped || (error && typeof error === 'object' && (('mayHaveRun' in error && error.mayHaveRun === false) || ('mayHaveBeenSent' in error && error.mayHaveBeenSent === false)));
						unknown = unknown || !unsent;
						throw error;
					} finally {
						inCall = false;
					}
				},
			};
			let response: NetworkHelperResponse;
			// An untracked legacy call may forward work before the helper can report its result.
			await persist({ endRule: { kind: 'boot' }, executorReturned: false });
			try {
				response = await withNativeMutationContext(context, execute);
			} catch (error) {
				unknown = unknown || !(error instanceof NativeMutationStopped || (allWritesTracked && !tracked));
				response = networkHelperFailure(error);
			}
			// Untracked work may have forwarded something whose downstream end left no evidence.
			if (!tracked && !allWritesTracked && !knownRefusal(response)) {
				unknown = true;
			}
			await persist(current => ({ phase: 'finished', executorReturned: unknown ? current.executorReturned : true, result: unknown ? { outcome: 'unknown' } : { outcome: 'known', response } }));
			await store.cleanup(bootId);
			return response;
		});
	} catch (error) {
		if (!entered) await store.write({ ...record, phase: 'finished', updatedAt: Date.now(), executorReturned: true, result: { outcome: 'known', response: networkHelperFailure(error) } });
		throw error;
	}
}
