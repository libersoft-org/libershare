import { NativeMutationBusy, type JournalValue, type NativeMutationDomain, type NativeMutationRecord } from './mutation-journal.ts';
import { hasNativeExecutionEnded, type NativeEndObservation, type NativeEndRule, type NativeProcessIdentity } from './mutation-proof.ts';
import { DBusTransportError } from './linux/dbus.ts';
import { NativeWorkerChannel, NativeWorkerFailure } from './worker-host.ts';

export interface NativeMutationState {
	readonly state: NativeMutationRecord['phase'];
	readonly since: number;
	readonly operation: string;
}

interface JournalEntry {
	readonly record: NativeMutationRecord;
	readonly revision: number;
}

export interface NativeMutationOptions {
	readonly domain: NativeMutationDomain;
	readonly operation: string;
	readonly requestHash: string;
	readonly recoveryData: JournalValue;
	readonly timeoutMs: number;
}

export type NativeMutationResult<T> = { readonly state: 'completed'; readonly value: T } | { readonly state: 'pending'; readonly operationId: string };
export type NativeInvocation<T> = { readonly known: true; readonly value: T } | { readonly known: false };
export type NativeSettlement = 'completed' | 'interrupted';

export class NativeMutationUnknown extends Error {
	constructor() {
		super('The native mutation may still be running');
		this.name = 'NativeMutationUnknown';
	}
}

export class NativeMutationStopped extends Error {
	constructor() {
		super('The mutation budget expired before the next step');
		this.name = 'NativeMutationStopped';
	}
}

export interface NativeMutationContext {
	readonly operationId: string;
	remainingMs(): number;
	call<T>(rule: NativeEndRule, invoke: () => Promise<NativeInvocation<T>>): Promise<T>;
	recordRecovery(data: Readonly<Record<string, JournalValue>>): Promise<void>;
	pending(rule: NativeEndRule): Promise<never>;
}

/** Journal I/O uses its own worker so a full fsync cannot block WebSocket requests. */
export class NativeMutationHost {
	private readonly directory: string;
	private readonly journal = new NativeWorkerChannel('mutation');
	private readonly reader = new NativeWorkerChannel('read');
	private readonly active = new Set<NativeMutationDomain>();
	private readonly endedOperations = new Map<string, number>();
	private closed = false;

	constructor(directory: string) {
		this.directory = directory;
	}

	private async read(domain: NativeMutationDomain): Promise<JournalEntry | null> {
		return this.reader.call({ method: 'journal.read', args: { directory: this.directory, domain } }, 5000);
	}

	async state(domain: NativeMutationDomain): Promise<NativeMutationState | undefined> {
		const entry = await this.read(domain);
		return entry ? { state: entry.record.phase, operation: entry.record.operation, since: entry.record.since } : undefined;
	}

	/** verify only reads state; compensating writes belong in action through context.call. */
	async run<T>(options: NativeMutationOptions, action: (context: NativeMutationContext) => Promise<T>, verify: (record: NativeMutationRecord) => Promise<NativeSettlement>): Promise<NativeMutationResult<T>> {
		if (this.closed) throw new Error('Native mutation host is closed');
		if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new NativeMutationStopped();
		if (this.active.has(options.domain)) throw new NativeMutationBusy(options.domain);
		this.active.add(options.domain);
		const deadline = performance.now() + options.timeoutMs;
		const operationId = crypto.randomUUID();
		const budget = { stopped: false };
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<NativeMutationResult<T>>(resolve => {
			timer = setTimeout(() => {
				budget.stopped = true;
				resolve({ state: 'pending', operationId });
			}, options.timeoutMs);
		});
		const execution = this.execute(options, operationId, deadline, budget, action, verify).finally(() => this.active.delete(options.domain));
		try {
			return await Promise.race([execution, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	private async execute<T>(options: NativeMutationOptions, operationId: string, deadline: number, budget: { stopped: boolean }, action: (context: NativeMutationContext) => Promise<T>, verify: (record: NativeMutationRecord) => Promise<NativeSettlement>): Promise<NativeMutationResult<T>> {
		let entry: JournalEntry;
		try {
			const identity = await this.reader.call<{ bootId: string | null; executor: NativeProcessIdentity }>({ method: 'identity.current' }, Math.min(5000, options.timeoutMs));
			if (performance.now() >= deadline) throw new NativeMutationStopped();
			entry = { revision: 0, record: { version: 1, operationId, requestHash: options.requestHash, domain: options.domain, operation: options.operation, since: Date.now(), phase: 'pending', ...identity, executorReturned: false, endRule: { kind: 'executor' }, recoveryData: options.recoveryData } };
			await this.journal.call({ method: 'journal.begin', args: { directory: this.directory, record: entry.record } });
		} catch (error) {
			this.active.delete(options.domain);
			throw error;
		}

		let unknown = false;
		let inCall = false;
		const persist = async (patch: Partial<NativeMutationRecord>): Promise<void> => {
			const record = { ...entry.record, ...patch };
			try {
				const revision = await this.journal.call<number>({ method: 'journal.update', args: { directory: this.directory, record, revision: entry.revision } });
				entry = { record, revision };
			} catch (error) {
				budget.stopped = true;
				throw error;
			}
		};
		const context: NativeMutationContext = {
			operationId: entry.record.operationId,
			remainingMs: () => Math.max(0, deadline - performance.now()),
			recordRecovery: async data => {
				if (unknown || inCall || budget.stopped) throw new NativeMutationUnknown();
				const previous = entry.record.recoveryData;
				if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new Error('Recovery fields require an object journal');
				await persist({ recoveryData: { ...previous, ...data } });
			},
			pending: async rule => {
				if (inCall) throw new NativeMutationUnknown();
				unknown = true;
				await persist({ endRule: rule, executorReturned: true });
				throw new NativeMutationUnknown();
			},
			call: async <V>(rule: NativeEndRule, invoke: () => Promise<NativeInvocation<V>>): Promise<V> => {
				if (unknown || inCall) throw new NativeMutationUnknown();
				if (budget.stopped || performance.now() >= deadline) throw new NativeMutationStopped();
				inCall = true;
				// Before dispatch, a crash must retain the rule for this exact receiver.
				try {
					await persist({ endRule: rule, executorReturned: false });
				} catch (error) {
					inCall = false;
					throw error;
				}
				let result: NativeInvocation<V>;
				try {
					if (budget.stopped || performance.now() >= deadline) {
						throw new NativeMutationStopped();
					}
					result = await invoke();
				} catch (error) {
					const unsent = error instanceof NativeMutationStopped || (error instanceof NativeWorkerFailure && !error.mayHaveRun) || (error instanceof DBusTransportError && !error.mayHaveBeenSent);
					unknown = !unsent;
					inCall = false;
					await persist({ executorReturned: unknown && !(error instanceof NativeWorkerFailure) });
					throw error;
				}
				unknown = !result.known;
				inCall = false;
				// A checkpoint may still have scheduled work after its method returned.
				await persist({ executorReturned: unknown });
				if (!result.known) throw new NativeMutationUnknown();
				return result.value;
			},
		};
		return (async (): Promise<NativeMutationResult<T>> => {
			let value: T | undefined;
			let failure: { error: unknown } | undefined;
			try {
				if (budget.stopped || performance.now() >= deadline) throw new NativeMutationStopped();
				value = await action(context);
			} catch (error) {
				failure = { error };
			}
			try {
				if (unknown || inCall) return { state: 'pending', operationId: entry.record.operationId };
				budget.stopped = true;
				await persist({ phase: 'settling', executorReturned: false, endRule: { kind: 'executor' } });
				let settlement: NativeSettlement;
				try {
					settlement = await verify(entry.record);
				} catch (error) {
					await persist({ executorReturned: true });
					throw error;
				}
				if (settlement === 'interrupted') {
					await persist({ phase: 'interrupted' });
					throw new Error('Native mutation left an interrupted state');
				}
				await this.finish(entry);
				this.endedOperations.delete(entry.record.operationId);
				if (failure) throw failure.error;
				return { state: 'completed', value: value as T };
			} catch (error) {
				if (!unknown && !inCall) this.endedOperations.set(entry.record.operationId, entry.revision);
				throw error;
			} finally {
				this.active.delete(options.domain);
			}
		})();
	}

	async acknowledge(domain: NativeMutationDomain): Promise<void> {
		if (this.active.has(domain)) throw new NativeMutationBusy(domain);
		const entry = await this.read(domain);
		if (!entry) return;
		if (entry.record.phase !== 'interrupted') throw new NativeMutationBusy(domain);
		await this.finish(entry, true);
	}

	/** Recovery here is read-only. An unmatched state remains locked for explicit acknowledgement. */
	async recover(domain: NativeMutationDomain, observe: (record: NativeMutationRecord) => Promise<NativeEndObservation>, verify: (record: NativeMutationRecord) => Promise<NativeSettlement>): Promise<void> {
		if (this.active.has(domain)) return;
		this.active.add(domain);
		try {
			let entry = await this.read(domain);
			if (!entry || entry.record.phase === 'interrupted') return;
			const observation = await observe(entry.record);
			if (this.endedOperations.get(entry.record.operationId) !== entry.revision && !hasNativeExecutionEnded(entry.record, observation)) return;
			const identity = await this.reader.call<{ bootId: string | null; executor: NativeProcessIdentity }>({ method: 'identity.current' }, 5000);
			// The CAS assigns recovery to one backend even if several saw the same proof.
			const record: NativeMutationRecord = { ...entry.record, ...identity, phase: 'settling', endRule: { kind: 'executor' }, executorReturned: false };
			const revision = await this.journal.call<number>({ method: 'journal.update', args: { directory: this.directory, record, revision: entry.revision } });
			entry = { record, revision };
			let settlement: NativeSettlement;
			try {
				settlement = await verify(record);
			} catch (error) {
				await this.journal.call({ method: 'journal.update', args: { directory: this.directory, record: { ...record, executorReturned: true }, revision } });
				throw error;
			}
			if (settlement === 'completed') {
				await this.finish(entry);
				this.endedOperations.delete(entry.record.operationId);
			} else await this.journal.call({ method: 'journal.update', args: { directory: this.directory, record: { ...record, phase: 'interrupted', executorReturned: true }, revision } });
		} finally {
			this.active.delete(domain);
		}
	}

	private async finish(entry: JournalEntry, acknowledge = false): Promise<void> {
		await this.journal.call({ method: 'journal.finish', args: { directory: this.directory, domain: entry.record.domain, operationId: entry.record.operationId, revision: entry.revision, acknowledge } });
	}

	close(): boolean {
		if (this.active.size) return false;
		this.closed = true;
		this.reader.close();
		return this.journal.close();
	}
}
