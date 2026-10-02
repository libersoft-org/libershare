import { dlopen, FFIType, ptr, read } from 'bun:ffi';
import { close, constants, fstat, ftruncate, read as readFile, write } from 'node:fs';
import { getSystemErrorName } from 'node:util';
import type { DatasetDirectoryHandle, DatasetEntryInfo, DatasetFileHandle } from './safe-dataset-types';

function failure(code: string, message: string): NodeJS.ErrnoException {
	return Object.assign(new Error(message), { code });
}

function component(name: string): Buffer {
	if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) throw failure('LISH_UNSAFE_PATH', 'Invalid dataset path component');
	return Buffer.from(`${name}\0`);
}

function loadNative() {
	if (process.platform !== 'linux' && process.platform !== 'darwin') throw failure('ENOTSUP', 'POSIX dataset access is unavailable');
	const library = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
	const api = dlopen(library, {
		mkdirat: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	});
	// Darwin's public openat is variadic: arm64 takes mode from the stack. The
	// fixed-argument syscall entry avoids passing mode with the wrong ABI.
	const openat = process.platform === 'darwin' ? dlopen(library, { __openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.u32], returns: FFIType.i32 } }).symbols.__openat : dlopen(library, { openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.u32], returns: FFIType.i32 } }).symbols.openat;
	const errno = process.platform === 'darwin' ? dlopen(library, { __error: { args: [], returns: FFIType.ptr } }).symbols.__error : dlopen(library, { __errno_location: { args: [], returns: FFIType.ptr } }).symbols.__errno_location;
	return { api, openat, errno };
}

let native: ReturnType<typeof loadNative> | undefined;
function nativeApi(): ReturnType<typeof loadNative> {
	return (native ??= loadNative());
}

function syscall(result: number): number {
	if (result >= 0) return result;
	const address = nativeApi().errno();
	if (address === null) throw failure('EIO', 'Cannot read filesystem error');
	const code = getSystemErrorName(-read.i32(address));
	throw failure(code === 'ELOOP' || code === 'ENOTDIR' || code === 'EISDIR' ? 'LISH_UNSAFE_PATH' : code, `Dataset filesystem operation failed: ${code}`);
}

function openAt(fd: number, name: Buffer, flags: number): number {
	// Node does not expose O_CLOEXEC. These are the native Linux and Darwin flags.
	const cloexec = process.platform === 'darwin' ? 0x1000000 : 0x80000;
	return syscall(nativeApi().openat(fd, ptr(name), flags | cloexec | constants.O_NONBLOCK, 0o600));
}

function loadRenamer() {
	const signature = { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 } as const;
	try {
		return process.platform === 'darwin' ? dlopen('/usr/lib/libSystem.B.dylib', { renameatx_np: signature }).symbols.renameatx_np : dlopen('libc.so.6', { renameat2: signature }).symbols.renameat2;
	} catch {
		throw failure('LISH_UNSAFE_PATH', 'Atomic no-replace rename is unavailable');
	}
}

let renamer: ReturnType<typeof loadRenamer> | undefined;
function renameNoReplace(fromFd: number, from: Buffer, toFd: number, to: Buffer): void {
	// Darwin RENAME_EXCL and Linux RENAME_NOREPLACE both refuse an existing target.
	try {
		syscall((renamer ??= loadRenamer())(fromFd, ptr(from), toFd, ptr(to), process.platform === 'darwin' ? 0x4 : 0x1));
	} catch (error) {
		if (['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) throw failure('LISH_UNSAFE_PATH', 'Atomic no-replace rename is unavailable');
		throw error;
	}
}

function directoryRemovalFlag(): number {
	return process.platform === 'darwin' ? 0x80 : 0x200;
}

/** Capture a name before checking it. Never unlink whatever later appears at the original name. */
async function removeCaptured(parent: number, name: Buffer, kind: 'file' | 'directory', expectedIdentity: string): Promise<void> {
	renamer ??= loadRenamer();
	const workspaceName = `.lish-remove-${crypto.randomUUID()}`;
	const workspace = component(workspaceName);
	const item = component('entry');
	syscall(nativeApi().api.symbols.mkdirat(parent, ptr(workspace), 0o700));
	let directory: number | undefined;
	let captured = false;
	try {
		directory = openAt(parent, workspace, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		renameNoReplace(parent, name, directory, item);
		captured = true;
		const fd = openAt(directory, item, constants.O_RDONLY | constants.O_NOFOLLOW | (kind === 'directory' ? constants.O_DIRECTORY : 0));
		try {
			const info = await statFd(fd);
			if (info.kind !== kind || info.identity !== expectedIdentity) throw failure('LISH_UNSAFE_PATH', 'Dataset entry changed before removal');
		} finally {
			await closeFd(fd);
		}
		syscall(nativeApi().api.symbols.unlinkat(directory, ptr(item), kind === 'directory' ? directoryRemovalFlag() : 0));
		captured = false;
	} catch (error) {
		if (captured && directory !== undefined) {
			try {
				renameNoReplace(directory, item, parent, name);
				captured = false;
			} catch {
				// The private directory protects ordinary pathname races, not malicious code with the same UID.
				throw Object.assign(failure('LISH_UNSAFE_PATH', 'Removal stopped; captured data was preserved'), { retainedDirectory: workspaceName });
			}
		}
		throw error;
	} finally {
		if (directory !== undefined) await closeFd(directory);
		if (!captured) syscall(nativeApi().api.symbols.unlinkat(parent, ptr(workspace), directoryRemovalFlag()));
	}
}

function statFd(fd: number): Promise<DatasetEntryInfo> {
	return new Promise((resolve, reject) => {
		fstat(fd, { bigint: true }, (error, info) => {
			if (error) {
				reject(error);
				return;
			}
			if (info.size < 0n || info.size > BigInt(Number.MAX_SAFE_INTEGER)) {
				reject(failure('LISH_UNSAFE_PATH', 'Dataset entry size is outside the supported range'));
				return;
			}
			resolve({ identity: `${info.dev}:${info.ino}`, kind: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', size: Number(info.size), links: Number(info.nlink) });
		});
	});
}

function closeFd(fd: number): Promise<void> {
	return new Promise((resolve, reject) => close(fd, error => (error ? reject(error) : resolve())));
}

class Descriptor {
	private readonly fd: number;
	private closing: Promise<void> | undefined;
	private readonly pending = new Set<Promise<unknown>>();
	constructor(fd: number) {
		this.fd = fd;
	}

	protected async use<T>(operation: (fd: number) => Promise<T>): Promise<T> {
		if (this.closing) throw failure('EBADF', 'Dataset handle is closed');
		const result = operation(this.fd);
		this.pending.add(result);
		try {
			return await result;
		} finally {
			this.pending.delete(result);
		}
	}

	stat(): Promise<DatasetEntryInfo> {
		return this.use(statFd);
	}

	close(): Promise<void> {
		return (this.closing ??= Promise.allSettled([...this.pending]).then(() => closeFd(this.fd)));
	}
}

function offset(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) throw failure('EINVAL', 'Invalid dataset file offset');
}

class FileHandle extends Descriptor implements DatasetFileHandle {
	read(buffer: Uint8Array, position: number): Promise<number> {
		offset(position);
		return this.use(fd => new Promise((resolve, reject) => readFile(fd, buffer, 0, buffer.byteLength, position, (error, count) => (error ? reject(error) : resolve(count)))));
	}

	write(buffer: Uint8Array, position: number): Promise<number> {
		offset(position);
		return this.use(fd => new Promise((resolve, reject) => write(fd, buffer, 0, buffer.byteLength, position, (error, count) => (error ? reject(error) : resolve(count)))));
	}

	truncate(size: number): Promise<void> {
		offset(size);
		return this.use(fd => new Promise((resolve, reject) => ftruncate(fd, size, error => (error ? reject(error) : resolve()))));
	}
}

async function checked<T extends Descriptor>(handle: T, kind: 'file' | 'directory'): Promise<T> {
	try {
		if ((await handle.stat()).kind !== kind) throw failure('LISH_UNSAFE_PATH', 'Unexpected dataset entry type');
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

class DirectoryHandle extends Descriptor implements DatasetDirectoryHandle {
	openDirectory(name: string): Promise<DatasetDirectoryHandle> {
		const path = component(name);
		return this.use(async fd => checked(new DirectoryHandle(openAt(fd, path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)), 'directory'));
	}

	createDirectory(name: string): Promise<DatasetDirectoryHandle> {
		const path = component(name);
		return this.use(async fd => {
			syscall(nativeApi().api.symbols.mkdirat(fd, ptr(path), 0o700));
			return checked(new DirectoryHandle(openAt(fd, path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)), 'directory');
		});
	}

	openFile(name: string, mode: 'read' | 'write' | 'create'): Promise<DatasetFileHandle> {
		const path = component(name);
		const flags = mode === 'read' ? constants.O_RDONLY : constants.O_RDWR | (mode === 'create' ? constants.O_CREAT | constants.O_EXCL : 0);
		return this.use(async fd => checked(new FileHandle(openAt(fd, path, flags | constants.O_NOFOLLOW)), 'file'));
	}

	removeFile(name: string, expectedIdentity: string): Promise<void> {
		const path = component(name);
		return this.use(fd => removeCaptured(fd, path, 'file', expectedIdentity));
	}

	removeDirectory(name: string, expectedIdentity: string): Promise<void> {
		const path = component(name);
		return this.use(fd => removeCaptured(fd, path, 'directory', expectedIdentity));
	}
}

/** Only the explicitly selected root may resolve through a link. Children use held directory descriptors. */
export async function openPosixDatasetDirectory(path: string): Promise<DatasetDirectoryHandle> {
	if (!path || path.includes('\0')) throw failure('LISH_UNSAFE_PATH', 'Invalid dataset root');
	const fd = openAt(process.platform === 'darwin' ? -2 : -100, Buffer.from(`${path}\0`), constants.O_RDONLY | constants.O_DIRECTORY);
	return checked(new DirectoryHandle(fd), 'directory');
}
