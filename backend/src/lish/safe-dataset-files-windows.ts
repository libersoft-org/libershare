import { dlopen, FFIType, ptr } from 'bun:ffi';
import { realpath } from 'node:fs/promises';
import type { DatasetDirectoryHandle, DatasetEntryInfo, DatasetFileHandle } from './safe-dataset-types.ts';
import { windowsDatasetError } from './windows-dataset-error.ts';

const READ_ATTRIBUTES = 0x80;
const SYNCHRONIZE = 0x100000;
const DELETE = 0x10000;
const OPEN_REPARSE_POINT = 0x200000;
const SYNCHRONOUS_IO_NONALERT = 0x20;
const SHARE_READ_WRITE = 3;
const INVALID_HANDLE = 0xffffffffffffffffn;

function nativeLibraries() {
	return {
		kernel: dlopen('kernel32.dll', {
			CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.u64 },
			CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
			GetLastError: { args: [], returns: FFIType.u32 },
			GetFileType: { args: [FFIType.u64], returns: FFIType.u32 },
			GetFileInformationByHandleEx: { args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
			SetFileInformationByHandle: { args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
			SetFilePointerEx: { args: [FFIType.u64, FFIType.i64, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
			ReadFile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			WriteFile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		}),
		nt: dlopen('ntdll.dll', {
			NtCreateFile: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
			RtlNtStatusToDosError: { args: [FFIType.i32], returns: FFIType.u32 },
		}),
	};
}

type NativeLibraries = ReturnType<typeof nativeLibraries>;
let libraries: NativeLibraries | undefined;

function native(): NativeLibraries {
	if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) throw new Error('Windows dataset handles require 64-bit Windows');
	return (libraries ??= nativeLibraries());
}

function fail(code: string, message: string): never {
	throw Object.assign(new Error(message), { code });
}

function windowsError(operation: string, number = native().kernel.symbols.GetLastError()): never {
	throw windowsDatasetError(operation, number);
}

function component(name: string): void {
	if (!name || name === '.' || name === '..' || /[\x00-\x1f\\/:*?"<>|]/u.test(name) || /[. ]$/u.test(name) || /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu.test(name)) {
		fail('LISH_UNSAFE_PATH', 'Unsafe dataset path component');
	}
	if (Buffer.byteLength(name, 'utf16le') > 65532) fail('LISH_UNSAFE_PATH', 'Dataset path component is too long');
}

function offset(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) fail('EINVAL', 'Invalid dataset file offset');
}

class WindowsHandle {
	private references = 1;
	private closed = false;
	private readonly handle: bigint;
	private readonly parent: WindowsHandle | undefined;

	constructor(handle: bigint, parent?: WindowsHandle) {
		this.handle = handle;
		this.parent = parent;
		if (parent) parent.references++;
	}

	value(): bigint {
		if (this.closed) fail('EBADF', 'Dataset handle is closed');
		return this.handle;
	}

	private release(): void {
		if (--this.references !== 0) return;
		const result = native().kernel.symbols.CloseHandle(this.handle);
		this.parent?.release();
		if (!result) windowsError('CloseHandle');
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.release();
	}

	async stat(): Promise<DatasetEntryInfo> {
		const handle = this.value();
		const kernel = native().kernel.symbols;
		const attributes = Buffer.alloc(8);
		if (!kernel.GetFileInformationByHandleEx(handle, 9, ptr(attributes), attributes.length)) windowsError('Read file attributes');
		if (attributes.readUInt32LE(0) & 0x400) fail('LISH_UNSAFE_PATH', 'Dataset child is a reparse point');
		if (kernel.GetFileType(handle) !== 1) fail('LISH_UNSAFE_PATH', 'Dataset object is not a disk file');
		const standard = Buffer.alloc(24);
		if (!kernel.GetFileInformationByHandleEx(handle, 1, ptr(standard), standard.length)) windowsError('Read file metadata');
		const identity = Buffer.alloc(24);
		if (!kernel.GetFileInformationByHandleEx(handle, 18, ptr(identity), identity.length)) windowsError('Read file identity');
		const size = standard.readBigInt64LE(8);
		if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) fail('EFBIG', 'Dataset file is too large');
		return { identity: identity.toString('hex'), kind: standard[21] ? 'directory' : 'file', size: Number(size), links: standard.readUInt32LE(16) };
	}

	async requireKind(kind: 'file' | 'directory'): Promise<void> {
		try {
			if ((await this.stat()).kind !== kind) fail('LISH_UNSAFE_PATH', `Dataset object is not a ${kind}`);
		} catch (error) {
			await this.close();
			throw error;
		}
	}
}

class WindowsFile extends WindowsHandle implements DatasetFileHandle {
	private transfer(buffer: Uint8Array, position: number, write: boolean): number {
		offset(position);
		const handle = this.value();
		if (!buffer.byteLength) return 0;
		if (buffer.byteLength > 0xffffffff) fail('EINVAL', 'Dataset IO buffer is too large');
		const kernel = native().kernel.symbols;
		// Synchronous calls do not yield between moving the pointer and doing the IO.
		if (!kernel.SetFilePointerEx(handle, BigInt(position), null, 0)) windowsError('Set file position');
		const count = Buffer.alloc(4);
		const operation = write ? kernel.WriteFile : kernel.ReadFile;
		if (!operation(handle, ptr(buffer), buffer.byteLength, ptr(count), null)) windowsError(write ? 'Write file' : 'Read file');
		return count.readUInt32LE(0);
	}

	async read(buffer: Uint8Array, position: number): Promise<number> {
		return this.transfer(buffer, position, false);
	}

	async write(buffer: Uint8Array, position: number): Promise<number> {
		return this.transfer(buffer, position, true);
	}

	async truncate(size: number): Promise<void> {
		offset(size);
		const info = Buffer.alloc(8);
		info.writeBigInt64LE(BigInt(size));
		if (!native().kernel.symbols.SetFileInformationByHandle(this.value(), 6, ptr(info), info.length)) windowsError('Truncate file');
	}
}

class WindowsDirectory extends WindowsHandle implements DatasetDirectoryHandle {
	private openChild(name: string, access: number, create: boolean, directory: boolean): bigint {
		component(name);
		const nameBytes = Buffer.from(name, 'utf16le');
		const unicode = Buffer.alloc(16);
		unicode.writeUInt16LE(nameBytes.length, 0);
		unicode.writeUInt16LE(nameBytes.length, 2);
		unicode.writeBigUInt64LE(BigInt(ptr(nameBytes)), 8);
		const attributes = Buffer.alloc(48);
		attributes.writeUInt32LE(attributes.length, 0);
		attributes.writeBigUInt64LE(this.value(), 8);
		attributes.writeBigUInt64LE(BigInt(ptr(unicode)), 16);
		attributes.writeUInt32LE(0x40, 24); // OBJ_CASE_INSENSITIVE
		const output = Buffer.alloc(8);
		const io = Buffer.alloc(16);
		const { nt } = native();
		// Omit type flags when opening existing children so reparse points reach our check.
		const options = OPEN_REPARSE_POINT | SYNCHRONOUS_IO_NONALERT | (create ? (directory ? 1 : 0x40) : 0);
		const status = nt.symbols.NtCreateFile(ptr(output), access | READ_ATTRIBUTES | SYNCHRONIZE, ptr(attributes), ptr(io), null, 0x80, SHARE_READ_WRITE, create ? 2 : 1, options, null, 0);
		if (status < 0) windowsError('Open dataset child', nt.symbols.RtlNtStatusToDosError(status));
		return output.readBigUInt64LE(0);
	}

	async openDirectory(name: string): Promise<DatasetDirectoryHandle> {
		const child = new WindowsDirectory(this.openChild(name, 0x21, false, true), this);
		await child.requireKind('directory');
		return child;
	}

	async createDirectory(name: string): Promise<DatasetDirectoryHandle> {
		const child = new WindowsDirectory(this.openChild(name, 0x21, true, true), this);
		await child.requireKind('directory');
		return child;
	}

	async openFile(name: string, mode: 'read' | 'write' | 'create'): Promise<DatasetFileHandle> {
		const child = new WindowsFile(this.openChild(name, mode === 'read' ? 1 : 3, mode === 'create', false), this);
		await child.requireKind('file');
		return child;
	}

	private async remove(name: string, kind: 'file' | 'directory', expectedIdentity: string): Promise<void> {
		const child = new WindowsHandle(this.openChild(name, DELETE, false, kind === 'directory'), this);
		try {
			const info = await child.stat();
			if (info.kind !== kind || info.identity !== expectedIdentity) fail('LISH_UNSAFE_PATH', 'Dataset object was replaced before removal');
			const disposition = new Uint8Array([1]);
			if (!native().kernel.symbols.SetFileInformationByHandle(child.value(), 4, ptr(disposition), disposition.length)) windowsError('Delete dataset child');
		} finally {
			await child.close();
		}
	}

	async removeFile(name: string, expectedIdentity: string): Promise<void> {
		await this.remove(name, 'file', expectedIdentity);
	}

	async removeDirectory(name: string, expectedIdentity: string): Promise<void> {
		await this.remove(name, 'directory', expectedIdentity);
	}
}

export async function openWindowsDatasetDirectory(path: string): Promise<DatasetDirectoryHandle> {
	const resolved = await realpath(path);
	const extended = resolved.startsWith('\\\\?\\') ? resolved : resolved.startsWith('\\\\') ? `\\\\?\\UNC\\${resolved.slice(2)}` : `\\\\?\\${resolved}`;
	const encoded = Buffer.from(`${extended}\0`, 'utf16le');
	// The explicitly selected root may resolve a link once; children never do.
	const handle = BigInt(native().kernel.symbols.CreateFileW(ptr(encoded), 0x21 | READ_ATTRIBUTES | SYNCHRONIZE, SHARE_READ_WRITE, null, 3, 0x02000000 | 0x00200000, 0n));
	if (handle === INVALID_HANDLE) windowsError('Open dataset root');
	const root = new WindowsDirectory(handle);
	await root.requireKind('directory');
	return root;
}
