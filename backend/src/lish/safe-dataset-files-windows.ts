// @ts-expect-error Bun embeds this self-contained JavaScript worker as a file asset.
import workerPath from './safe-dataset-windows-worker.js' with { type: 'file' };
import type { DatasetDirectoryHandle, DatasetEntryInfo, DatasetFileHandle, DatasetContentGuard } from './safe-dataset-types.ts';
import { windowsDatasetError } from './windows-dataset-error.ts';
import { realpath } from 'node:fs/promises';
import { win32 } from 'node:path';

type Request = { operation: 'openRoot'; path: string } | { operation: 'stat' | 'close'; handle: number } | { operation: 'openDirectory' | 'createDirectory'; handle: number; name: string } | { operation: 'openFile'; handle: number; name: string; mode: 'read' | 'write' | 'create' } | { operation: 'removeFile' | 'removeDirectory'; handle: number; name: string; identity: string; guard?: DatasetContentGuard } | { operation: 'read'; handle: number; length: number; position: number } | { operation: 'write'; handle: number; bytes: Uint8Array; position: number } | { operation: 'truncate'; handle: number; size: number };

type Reply = { id: number; value?: unknown; error?: { message: string; code?: string; operation?: string; number?: number } };

const OPENS_HANDLE = new Set<Request['operation']>(['openRoot', 'openDirectory', 'createDirectory', 'openFile']);

class WindowsIO {
	private readonly worker = new Worker(workerPath);
	private readonly pending = new Map<number, { operation: Request['operation']; resolve(value: unknown): void; reject(error: Error): void }>();
	private nextID = 1;
	private failure: Error | undefined;
	/** Handles the worker holds open; with none and nothing pending the worker is ended. */
	private handles = 0;
	private retired = false;
	private readonly retire: () => void;

	/** @param retire Called once when this worker ends, idle or failed, so it is no longer handed out. */
	constructor(retire: () => void) {
		this.retire = retire;
		this.worker.unref();
		this.worker.onmessage = (event: MessageEvent<Reply>) => {
			const { id, value, error } = event.data;
			const request = this.pending.get(id);
			if (!request) return;
			this.pending.delete(id);
			if (this.pending.size === 0) this.worker.unref();
			if (!error && OPENS_HANDLE.has(request.operation)) this.handles++;
			// The worker forgets the handle even when closing it reports an error.
			if (request.operation === 'close') this.handles--;
			if (error) request.reject(error.number !== undefined && error.operation ? windowsDatasetError(error.operation, error.number) : Object.assign(new Error(error.message), { code: error.code }));
			else request.resolve(value);
			if (this.handles === 0 && this.pending.size === 0) this.end();
		};
		const fail = (): void => {
			if (this.retired) return;
			this.failure = Object.assign(new Error('Windows dataset worker stopped'), { code: 'EIO' });
			for (const request of this.pending.values()) request.reject(this.failure);
			this.pending.clear();
			this.worker.unref();
			this.end();
		};
		this.worker.onerror = event => {
			event.preventDefault();
			fail();
		};
		this.worker.addEventListener('close', fail);
	}

	private end(): void {
		if (this.retired) return;
		this.retired = true;
		this.retire();
		void this.worker.terminate();
	}

	async call<T>(request: Request): Promise<T> {
		if (this.failure) throw this.failure;
		if (this.retired) throw Object.assign(new Error('Windows dataset worker ended'), { code: 'EBADF' });
		const id = this.nextID++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { operation: request.operation, resolve: value => resolve(value as T), reject });
			this.worker.ref();
			try {
				this.worker.postMessage({ id, request }, request.operation === 'write' ? [request.bytes.buffer as ArrayBuffer] : []);
			} catch (error) {
				this.pending.delete(id);
				if (this.pending.size === 0) this.worker.unref();
				reject(error);
				if (this.handles === 0 && this.pending.size === 0) this.end();
			}
		});
	}
}

/**
 * One worker per volume, keyed by drive letter or `\\server\share`. Its calls are synchronous,
 * so a share that stops answering would otherwise hold every other dataset's IO behind it.
 * A worker ends once it holds no open handle and has nothing pending.
 */
const workers = new Map<string, WindowsIO>();

class WindowsHandle {
	protected readonly io: WindowsIO;
	protected readonly handle: number;
	private closing: Promise<void> | undefined;

	constructor(io: WindowsIO, handle: number) {
		this.io = io;
		this.handle = handle;
	}

	protected active(): void {
		if (this.closing) throw Object.assign(new Error('Dataset handle is closed'), { code: 'EBADF' });
	}

	async stat(): Promise<DatasetEntryInfo> {
		this.active();
		return this.io.call({ operation: 'stat', handle: this.handle });
	}

	close(): Promise<void> {
		return (this.closing ??= this.io.call({ operation: 'close', handle: this.handle }));
	}
}

class WindowsFile extends WindowsHandle implements DatasetFileHandle {
	async read(buffer: Uint8Array, position: number): Promise<number> {
		this.active();
		const bytes = await this.io.call<Uint8Array>({ operation: 'read', handle: this.handle, length: buffer.byteLength, position });
		buffer.set(bytes);
		return bytes.byteLength;
	}

	async write(buffer: Uint8Array, position: number): Promise<number> {
		this.active();
		// Transfer a private copy; the caller may reuse its buffer after this operation.
		return this.io.call({ operation: 'write', handle: this.handle, bytes: new Uint8Array(buffer), position });
	}

	async truncate(size: number): Promise<void> {
		this.active();
		await this.io.call({ operation: 'truncate', handle: this.handle, size });
	}
}

class WindowsDirectory extends WindowsHandle implements DatasetDirectoryHandle {
	async openDirectory(name: string): Promise<DatasetDirectoryHandle> {
		this.active();
		return new WindowsDirectory(this.io, await this.io.call({ operation: 'openDirectory', handle: this.handle, name }));
	}

	async createDirectory(name: string): Promise<DatasetDirectoryHandle> {
		this.active();
		return new WindowsDirectory(this.io, await this.io.call({ operation: 'createDirectory', handle: this.handle, name }));
	}

	async openFile(name: string, mode: 'read' | 'write' | 'create'): Promise<DatasetFileHandle> {
		this.active();
		return new WindowsFile(this.io, await this.io.call({ operation: 'openFile', handle: this.handle, name, mode }));
	}

	async removeFile(name: string, expectedIdentity: string, guard?: DatasetContentGuard): Promise<void> {
		this.active();
		await this.io.call({ operation: 'removeFile', handle: this.handle, name, identity: expectedIdentity, ...(guard ? { guard } : {}) });
	}

	async removeDirectory(name: string, expectedIdentity: string): Promise<void> {
		this.active();
		await this.io.call({ operation: 'removeDirectory', handle: this.handle, name, identity: expectedIdentity });
	}
}

export async function openWindowsDatasetDirectory(path: string): Promise<DatasetDirectoryHandle> {
	if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) throw new Error('Windows dataset handles require 64-bit Windows');
	// Keyed by where the path really leads: a link on C: to a share must not share C:'s worker.
	// The worker resolves the root again itself; this only picks the queue.
	const volume = windowsVolumeKey(await realpath(path).catch(() => path));
	let worker = workers.get(volume);
	if (!worker) {
		const created: WindowsIO = new WindowsIO(() => {
			if (workers.get(volume) === created) workers.delete(volume);
		});
		workers.set(volume, (worker = created));
	}
	return new WindowsDirectory(worker, await worker.call({ operation: 'openRoot', path }));
}

/** The volume a Windows path lives on, lower-cased: `c:`, `\\server\share` or a `\\?\` volume name. */
export function windowsVolumeKey(path: string): string {
	const plain = path.replace(/^[\\/]{2}[?.][\\/]UNC[\\/]/iu, '\\\\').replace(/^[\\/]{2}[?.][\\/](?=[A-Za-z]:)/u, '');
	// `\\?\Volume{guid}\…` and other device paths: the device name is the volume.
	const device = /^[\\/]{2}[?.][\\/]([^\\/]+)/u.exec(plain);
	if (device) return device[1]!.toLowerCase();
	const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/u.exec(plain);
	if (unc) return `\\\\${unc[1]}\\${unc[2]}`.toLowerCase();
	const drive = /^([A-Za-z]:)/u.exec(plain);
	if (drive) return drive[1]!.toLowerCase();
	return win32.parse(win32.resolve(plain)).root.toLowerCase();
}

/** How many dataset workers are running; for tests. */
export function windowsDatasetWorkerCount(): number {
	return workers.size;
}
