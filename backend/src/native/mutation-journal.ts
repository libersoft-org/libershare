import { isUniqueDBusName } from './linux/dbus.ts';
import { Database } from 'bun:sqlite';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { NativePendingExecution, NativeProcessIdentity } from './mutation-proof.ts';

export type NativeMutationDomain = 'network' | 'time';
export type NativeMutationPhase = 'pending' | 'settling' | 'interrupted';
export type JournalValue = null | boolean | number | string | JournalValue[] | { [key: string]: JournalValue };

export interface NativeMutationRecord extends NativePendingExecution {
	readonly version: 1;
	readonly operationId: string;
	readonly requestHash: string;
	readonly domain: NativeMutationDomain;
	readonly operation: string;
	readonly since: number;
	readonly phase: NativeMutationPhase;
	/** Adapter-owned, JSON-safe recovery data. Secrets must be replaced with salted fingerprints. */
	readonly recoveryData: JournalValue;
}

export class NativeMutationBusy extends Error {
	readonly domain: NativeMutationDomain;
	constructor(domain: NativeMutationDomain) {
		super(`A ${domain} mutation has not finished`);
		this.name = 'NativeMutationBusy';
		this.domain = domain;
	}
}

function processIdentity(value: unknown): value is NativeProcessIdentity {
	if (!value || typeof value !== 'object') return false;
	const identity = value as NativeProcessIdentity;
	return Number.isSafeInteger(identity.pid) && identity.pid > 0 && typeof identity.started === 'string' && identity.started.length > 0;
}

export function validateMutationRecord(value: unknown): asserts value is NativeMutationRecord {
	if (!value || typeof value !== 'object') throw new Error('Invalid native mutation journal');
	const record = value as NativeMutationRecord;
	const rule = record.endRule;
	if (typeof record.executorReturned !== 'boolean') throw new Error('Invalid native executor state');
	if (record.version !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(record.operationId) || !/^[a-f0-9]{64}$/i.test(record.requestHash) || !['network', 'time'].includes(record.domain) || !['pending', 'settling', 'interrupted'].includes(record.phase) || typeof record.operation !== 'string' || !record.operation || !Number.isFinite(record.since) || !processIdentity(record.executor) || (record.bootId !== null && (typeof record.bootId !== 'string' || !record.bootId)) || !rule || typeof rule !== 'object' || !['executor', 'boot', 'dbus-process', 'helper'].includes(rule.kind)) throw new Error('Invalid native mutation journal');
	if (rule.kind === 'dbus-process' && (typeof rule.busId !== 'string' || !rule.busId || !isUniqueDBusName(rule.destination) || !processIdentity(rule.process))) throw new Error('Invalid native mutation endpoint');
	if (rule.kind === 'helper' && (rule.operationId !== record.operationId || !/^[a-f0-9]{64}$/i.test(rule.requestHash) || typeof rule.cancelPath !== 'string' || !isAbsolute(rule.cancelPath) || (rule.launcher !== null && !processIdentity(rule.launcher)))) throw new Error('Invalid native helper identity');
	if (!Object.prototype.hasOwnProperty.call(record, 'recoveryData') || record.recoveryData === undefined) throw new Error('Missing native mutation recovery data');
}

function encode(record: NativeMutationRecord): string {
	validateMutationRecord(record);
	return JSON.stringify(record, (_key, value: unknown) => {
		if (value === undefined || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol' || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Native recovery data must be JSON-safe');
		return value;
	});
}

function privateJournalPath(path: string, directory: boolean): void {
	const info = lstatSync(path);
	if (directory ? !info.isDirectory() : !info.isFile()) throw new Error('Invalid native journal path');
	if (process.platform !== 'win32' && (info.uid !== process.getuid!() || (info.mode & 0o022) !== 0)) throw new Error('Untrusted native journal permissions');
}

/** A unique row per domain arbitrates across backend instances sharing the data directory. */
export class NativeMutationJournal {
	private readonly database: Database;
	constructor(dataDirectory: string) {
		const directory = join(dataDirectory, 'native-operations');
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		privateJournalPath(directory, true);
		const file = join(directory, 'mutations.sqlite');
		try {
			privateJournalPath(file, false);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		this.database = new Database(file, { create: true, strict: true });
		try {
			if (process.platform !== 'win32') chmodSync(file, 0o600);
			this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 0;');
			this.database.exec('CREATE TABLE IF NOT EXISTS mutations (domain TEXT PRIMARY KEY, operation_id TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL)');
		} catch (error) {
			this.database.close();
			throw error;
		}
	}

	read(domain: NativeMutationDomain): { record: NativeMutationRecord; revision: number } | null {
		const row = this.database.query<{ record: string; revision: number; operation_id: string }, [string]>('SELECT record, revision, operation_id FROM mutations WHERE domain = ?').get(domain);
		if (!row) return null;
		const record: unknown = JSON.parse(row.record);
		validateMutationRecord(record);
		if (record.domain !== domain || record.operationId !== row.operation_id || !Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error('Invalid native journal identity');
		return { record, revision: row.revision };
	}

	begin(record: NativeMutationRecord): void {
		validateMutationRecord(record);
		if (record.phase !== 'pending') throw new Error('A native mutation must begin pending');
		const text = encode(record);
		this.database
			.transaction(() => {
				if (this.read(record.domain)) throw new NativeMutationBusy(record.domain);
				this.database.query('INSERT INTO mutations (domain, operation_id, revision, record) VALUES (?, ?, 0, ?)').run(record.domain, record.operationId, text);
			})
			.immediate();
	}

	update(record: NativeMutationRecord, revision: number): number {
		validateMutationRecord(record);
		const text = encode(record);
		const result = this.database.query('UPDATE mutations SET record = ?, revision = revision + 1 WHERE domain = ? AND operation_id = ? AND revision = ?').run(text, record.domain, record.operationId, revision);
		if (result.changes !== 1) throw new Error('Native mutation ownership changed');
		return revision + 1;
	}

	finish(domain: NativeMutationDomain, operationId: string, revision: number, acknowledge = false): void {
		this.database
			.transaction(() => {
				const current = this.read(domain);
				if (!current || current.record.operationId !== operationId || current.revision !== revision) throw new Error('Native mutation ownership changed');
				if (current.record.phase !== (acknowledge ? 'interrupted' : 'settling')) throw new NativeMutationBusy(domain);
				this.database.query('DELETE FROM mutations WHERE domain = ? AND operation_id = ? AND revision = ?').run(domain, operationId, revision);
			})
			.immediate();
	}

	close(): void {
		this.database.close();
	}
}
