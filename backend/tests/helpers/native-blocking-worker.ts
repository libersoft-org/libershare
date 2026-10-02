import { parentPort } from 'node:worker_threads';
import { FFIType } from 'bun:ffi';
import { loadSystemLibrary } from '../../src/native/library.ts';

parentPort!.on('message', ({ id, method, args }: { id: number; method: string; args: { marker?: Int32Array; milliseconds?: number; value?: unknown } }) => {
	if (method === 'exit') {
		process.exit(0);
		return;
	}
	if (method === 'block') {
		const windows = process.platform === 'win32';
		const symbol = windows ? 'Sleep' : 'usleep';
		const library = loadSystemLibrary(windows ? 'kernel32.dll' : process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
			[symbol]: { args: [FFIType.u32], returns: windows ? FFIType.void : FFIType.i32 },
		});
		if (args.marker) Atomics.store(args.marker, 0, 1);
		library.symbols[symbol]!((args.milliseconds ?? 200) * (windows ? 1 : 1000));
		if (args.marker) Atomics.store(args.marker, 1, 1);
		library.close();
	}
	parentPort!.postMessage({ id, ok: true, value: args.value });
});
