import { describe, expect, test } from 'bun:test';
import { FFIType } from 'bun:ffi';
import { darwinSystemLibraryPath, linuxSystemLibraryPath, loadSystemLibrary, NativeLibraryUnavailable, windowsSystemLibraryPath, type LinuxLibraryFilesystem } from '../../src/native/library.ts';

function filesystem() {
	const entries = new Map<string, { uid: number; mode: number; directory: boolean }>();
	const aliases = new Map<string, string>();
	for (const path of ['/', '/usr', '/usr/lib', '/usr/lib/x86_64-linux-gnu']) entries.set(path, { uid: 0, mode: 0o755, directory: true });
	const path = '/usr/lib/x86_64-linux-gnu/libtest.so.1';
	entries.set(path, { uid: 0, mode: 0o644, directory: false });
	const deps: LinuxLibraryFilesystem = {
		realpath: name => {
			const resolved = aliases.get(name) ?? name;
			if (!entries.has(resolved)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
			return resolved;
		},
		stat: name => {
			const info = entries.get(name);
			if (!info) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
			return { ...info, isDirectory: () => info.directory, isFile: () => !info.directory };
		},
	};
	return { entries, aliases, deps, path };
}

describe('system library paths', () => {
	test('resolves a versioned Linux library only through trusted system directories', () => {
		const f = filesystem();
		const target = `${f.path}.2`;
		f.entries.set(target, f.entries.get(f.path)!);
		f.aliases.set(f.path, target);
		expect(linuxSystemLibraryPath('libtest.so.1', f.deps, 'x64')).toBe(target);
	});
	test.each(['/usr', '/usr/lib', '/usr/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu/libtest.so.1'])('refuses unprivileged ownership or write access at %s', path => {
		for (const patch of [{ uid: 1000 }, { mode: 0o775 }, { mode: 0o777 }]) {
			const f = filesystem();
			Object.assign(f.entries.get(path)!, patch);
			expect(() => linuxSystemLibraryPath('libtest.so.1', f.deps, 'x64')).toThrow(NativeLibraryUnavailable);
		}
	});
	test('supports distributions with flat library directories', () => {
		const f = filesystem();
		f.entries.delete(f.path);
		f.entries.set('/usr/lib/libtest.so.1', { uid: 0, mode: 0o644, directory: false });
		expect(linuxSystemLibraryPath('libtest.so.1', f.deps, 'arm64')).toBe('/usr/lib/libtest.so.1');
	});
	test('refuses a library symlink escaping the system library roots', () => {
		const f = filesystem();
		f.entries.set('/opt/private-library.so', { uid: 0, mode: 0o644, directory: false });
		f.aliases.set(f.path, '/opt/private-library.so');
		expect(() => linuxSystemLibraryPath('libtest.so.1', f.deps, 'x64')).toThrow(NativeLibraryUnavailable);
	});
	test.each(['../libtest.so.1', '/tmp/libtest.so.1', 'libtest.so.1\0', 'libtest.so.1/other'])('refuses a non-basename Linux request: %j', name => {
		expect(() => linuxSystemLibraryPath(name, filesystem().deps, 'x64')).toThrow(NativeLibraryUnavailable);
	});
	test('accepts dyld-cache framework paths without requiring a filesystem entry', () => {
		const path = '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation';
		expect(darwinSystemLibraryPath(path)).toBe(path);
	});
	test.each(['/tmp/library.dylib', 'libobjc.A.dylib', '/usr/lib/../../tmp/library.dylib', '/usr/lib/x\0'])('refuses a non-system Darwin path: %j', path => {
		expect(() => darwinSystemLibraryPath(path)).toThrow(NativeLibraryUnavailable);
	});
	test.each(['../kernel32.dll', 'C:\\Temp\\kernel32.dll', 'kernel32.dll\0', 'kernel32.dll:extra'])('refuses a non-basename Windows request: %j', name => {
		expect(() => windowsSystemLibraryPath(name)).toThrow(NativeLibraryUnavailable);
	});
});

test('loads and calls the actual host library through the production loader', () => {
	if (process.platform === 'win32') {
		const lib = loadSystemLibrary('kernel32.dll', { GetCurrentProcessId: { args: [], returns: FFIType.u32 } });
		try {
			expect(lib.symbols.GetCurrentProcessId()).toBe(process.pid);
		} finally {
			lib.close();
		}
	} else {
		const lib = loadSystemLibrary(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', { getpid: { args: [], returns: FFIType.i32 } });
		try {
			expect(lib.symbols.getpid()).toBe(process.pid);
		} finally {
			lib.close();
		}
	}
});

test('reports a missing required symbol as an unavailable capability', () => {
	const name = process.platform === 'win32' ? 'kernel32.dll' : process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
	expect(() => loadSystemLibrary(name, { lish_missing_native_symbol: { args: [], returns: FFIType.i32 } })).toThrow(NativeLibraryUnavailable);
});
