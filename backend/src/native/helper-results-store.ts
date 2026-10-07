import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { encodeNetworkHelperRequest, isHelperOperationId, parseNetworkHelperResponse, type NetworkHelperRequest, type NetworkHelperResponse } from '../network-helper-protocol.ts';
import { windowsProgramDataPath } from '../network-helper-windows.ts';
import type { NativeEndRule } from './mutation-proof.ts';
import { validateMutationRecord, type NativeMutationDomain, type JournalValue } from './mutation-journal.ts';
import { assertWindowsHelperResultAccess, createWindowsHelperResultDirectory, replaceWindowsHelperResult, writeProtectedWindowsHelperFile } from './helper-results-windows.ts';

export interface HelperResultRecord {
	readonly version: 2;
	readonly helperVersion: 2;
	readonly operationId: string;
	readonly requestHash: string;
	readonly pid: number;
	readonly processStart: string;
	readonly bootId: string | null;
	readonly domain: NativeMutationDomain;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly phase: 'started' | 'cancelled' | 'finished';
	readonly executorReturned: boolean;
	readonly endRule: NativeEndRule;
	readonly recoveryData?: Readonly<Record<string, JournalValue>>;
	readonly result?: { readonly outcome: 'known'; readonly response: NetworkHelperResponse } | { readonly outcome: 'unknown' };
}

export interface HelperResultSecurity {
	verify(path: string, directory: boolean, anchor?: boolean): Promise<void>;
	/** `owned`: the directory belongs to the helper, so an existing one may have its read access repaired. */
	createDirectory(path: string, owned: boolean): Promise<void>;
	writeNew(path: string, text: string): Promise<void>;
}

export function helperRequestHash(request: NetworkHelperRequest | string): string {
	return createHash('sha256')
		.update(typeof request === 'string' ? request : encodeNetworkHelperRequest(request))
		.digest('hex');
}

export function helperResultsDirectory(): string {
	if (process.platform === 'win32') return join(windowsProgramDataPath(), 'LiberShare', 'helper-results');
	if (process.platform === 'darwin') return '/Library/Application Support/LiberShare/helper-results';
	if (process.platform === 'linux') return '/var/lib/libershare-helper-results';
	throw new Error('Privileged helper results are unavailable on this platform');
}

export function trustedUnixHelperResult(uid: number, mode: number): boolean {
	return uid === 0 && (mode & 0o022) === 0;
}

/**
 * The modes are set explicitly after creation: the helper may run under a restrictive umask (077),
 * which would leave results the unprivileged backend cannot read and turn every change into an
 * unknown outcome.
 */
export const helperResultSecurity: HelperResultSecurity = {
	verify: async (path, directory, anchor = false) => {
		const info = await lstat(path);
		if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error('Invalid helper result path');
		if (process.platform === 'win32') assertWindowsHelperResultAccess(path, anchor);
		else if (!trustedUnixHelperResult(info.uid, info.mode)) throw new Error('Untrusted helper result permissions');
	},
	createDirectory: async (path, owned) => {
		if (process.platform === 'win32') {
			createWindowsHelperResultDirectory(path);
			return;
		}
		try {
			await mkdir(path, { mode: 0o755 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			if (!owned) return;
			// Only the helper's own root-owned directory is repaired, never a symlink or a system parent.
			const info = await lstat(path);
			if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== 0 || process.getuid?.() !== 0) return;
		}
		await chmod(path, 0o755);
	},
	writeNew: async (path, text) => {
		if (process.platform === 'win32') {
			writeProtectedWindowsHelperFile(path, text);
			return;
		}
		const handle = await open(path, 'wx', 0o644);
		try {
			await handle.chmod(0o644);
			await handle.writeFile(text);
			await handle.sync();
		} finally {
			await handle.close();
		}
	},
};

async function syncDirectory(path: string): Promise<void> {
	// Windows publication uses MoveFileExW(MOVEFILE_WRITE_THROUGH).
	if (process.platform === 'win32') return;
	const handle = await open(path, 'r');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export function validateHelperResult(value: unknown): asserts value is HelperResultRecord {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid helper result');
	const record = value as HelperResultRecord;
	const keys = ['version', 'helperVersion', 'operationId', 'requestHash', 'pid', 'processStart', 'bootId', 'domain', 'createdAt', 'updatedAt', 'phase', 'executorReturned', 'endRule', 'recoveryData', 'result'];
	if (Object.keys(record).some(key => !keys.includes(key)) || record.version !== 2 || record.helperVersion !== 2 || !isHelperOperationId(record.operationId) || !/^[0-9a-f]{64}$/.test(record.requestHash) || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt) || !['started', 'cancelled', 'finished'].includes(record.phase) || !record.endRule || !['executor', 'boot', 'dbus-process'].includes(record.endRule.kind)) throw new Error('Invalid helper result');
	validateMutationRecord({ version: 1, operationId: record.operationId, requestHash: record.requestHash, domain: record.domain, operation: 'helper', since: record.createdAt, phase: 'pending', executor: { pid: record.pid, started: record.processStart }, bootId: record.bootId, executorReturned: record.executorReturned, endRule: record.endRule, recoveryData: null });
	if (record.recoveryData !== undefined && (!record.recoveryData || typeof record.recoveryData !== 'object' || Array.isArray(record.recoveryData))) throw new Error('Invalid helper recovery data');
	if (record.phase === 'finished') {
		if (!record.result || (record.result.outcome !== 'known' && record.result.outcome !== 'unknown')) throw new Error('Missing helper result outcome');
		if (record.result.outcome === 'known') {
			if (Object.keys(record.result).sort().join() !== 'outcome,response') throw new Error('Invalid helper result outcome');
			parseNetworkHelperResponse(JSON.stringify(record.result.response));
		} else if (Object.keys(record.result).join() !== 'outcome') throw new Error('Invalid helper result outcome');
	} else if (record.result !== undefined) throw new Error('Unexpected helper result outcome');
}

export function helperResultCanExpire(record: HelperResultRecord, bootId: string | null, now: number): boolean {
	if (record.bootId && bootId && record.bootId !== bootId) return true;
	return now - record.updatedAt >= 7 * 86400000 && (record.phase === 'cancelled' || (record.phase === 'finished' && record.result?.outcome === 'known'));
}

export class HelperResultStore {
	readonly directory: string;
	private readonly permissions: HelperResultSecurity;
	constructor(directory: string = helperResultsDirectory(), permissions: HelperResultSecurity = helperResultSecurity) {
		if (!isAbsolute(directory)) throw new Error('Helper result directory must be absolute');
		this.directory = directory;
		this.permissions = permissions;
	}
	private path(id: string): string {
		if (!isHelperOperationId(id)) throw new Error('Invalid helper operation ID');
		return join(this.directory, `${id}.json`);
	}
	async prepare(): Promise<void> {
		const parent = dirname(this.directory),
			anchor = dirname(parent);
		await this.permissions.verify(anchor, true, process.platform === 'win32');
		// The parent is the helper's own only when it is a LiberShare directory, not a system one such as /var/lib.
		for (const [path, owned] of [
			[parent, basename(parent) === 'LiberShare'],
			[this.directory, true],
		] as const) {
			await this.permissions.createDirectory(path, owned);
			await this.permissions.verify(path, true);
		}
	}
	private async verifyDirectories(): Promise<void> {
		await this.permissions.verify(dirname(dirname(this.directory)), true, process.platform === 'win32');
		await this.permissions.verify(dirname(this.directory), true);
		await this.permissions.verify(this.directory, true);
	}
	async read(id: string): Promise<HelperResultRecord | null> {
		const value = await this.readFile(this.path(id));
		if (value && value.operationId !== id) throw new Error('Mismatched helper result identity');
		return value;
	}
	async readActive(domain: NativeMutationDomain): Promise<HelperResultRecord | null> {
		const value = await this.readFile(join(this.directory, `active-${domain}.json`));
		if (value && value.domain !== domain) throw new Error('Mismatched helper mutation domain');
		return value;
	}
	private async readFile(file: string): Promise<HelperResultRecord | null> {
		try {
			await this.verifyDirectories();
			await this.permissions.verify(file, false);
			const handle = await open(file, 'r');
			try {
				const buffer = Buffer.alloc(65537);
				let bytesRead = 0;
				while (bytesRead < buffer.length) {
					const part = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
					if (part.bytesRead === 0) break;
					bytesRead += part.bytesRead;
				}
				if (bytesRead > 65536) throw new Error('Oversized helper result');
				const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
				validateHelperResult(value);
				return value;
			} finally {
				await handle.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw error;
		}
	}
	async start(record: HelperResultRecord): Promise<void> {
		if (record.phase !== 'started') throw new Error('A helper must start before checking cancellation');
		await this.prepare();
		const claim = `${this.path(record.operationId)}.claim`;
		await this.permissions.writeNew(claim, JSON.stringify(record));
		try {
			if (await this.read(record.operationId)) throw new Error('Helper operation was already claimed');
			await this.write(record);
		} finally {
			await unlink(claim);
		}
	}
	async write(record: HelperResultRecord): Promise<void> {
		await this.writeFile(this.path(record.operationId), record);
	}
	async writeActive(record: HelperResultRecord): Promise<void> {
		await this.writeFile(join(this.directory, `active-${record.domain}.json`), record);
	}
	private async writeFile(target: string, record: HelperResultRecord): Promise<void> {
		validateHelperResult(record);
		await this.verifyDirectories();
		const temporary = `${target}.${randomUUID()}.tmp`,
			text = JSON.stringify(record);
		if (Buffer.byteLength(text) > 65536) throw new Error('Oversized helper result');
		try {
			await this.permissions.writeNew(temporary, text);
			if (process.platform === 'win32') replaceWindowsHelperResult(temporary, target);
			else await rename(temporary, target);
			await syncDirectory(this.directory);
		} catch (error) {
			await unlink(temporary).catch(() => undefined);
			throw error;
		}
	}
	async cleanup(bootId: string | null, now: number = Date.now()): Promise<void> {
		await this.verifyDirectories();
		let active: Set<string | undefined>;
		try {
			active = new Set((await Promise.all([this.readActive('network'), this.readActive('time')])).map(record => record?.operationId));
		} catch {
			return;
		} // Retention cannot discard evidence while active ownership is unreadable.
		for (const file of await readdir(this.directory)) {
			if (file.endsWith('.json.claim') && isHelperOperationId(file.slice(0, -11))) {
				try {
					const claim = await this.readFile(join(this.directory, file));
					if (claim?.bootId && bootId && claim.bootId !== bootId) await unlink(join(this.directory, file));
				} catch {
					/* An unreadable ownership claim must be retained. */
				}
				continue;
			}
			if (!file.endsWith('.json') || !isHelperOperationId(file.slice(0, -5))) continue;
			if (active.has(file.slice(0, -5))) continue;
			let record: HelperResultRecord | null;
			try {
				record = await this.read(file.slice(0, -5));
			} catch {
				continue;
			} // Keep corrupt or inaccessible evidence.
			if (record && helperResultCanExpire(record, bootId, now)) await unlink(join(this.directory, file));
		}
		await syncDirectory(this.directory);
	}
}

export async function createHelperCancellation(path: string): Promise<void> {
	if (!isAbsolute(path)) throw new Error('Cancellation path must be absolute');
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const handle = await open(path, 'wx', 0o600).catch(error => {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
		throw error;
	});
	if (handle) {
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}
	await syncDirectory(dirname(path));
}

export async function helperCancellationExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}
