import { dlopen, FFIType } from 'bun:ffi';
import { beginCoreWlanAssociation } from '../../src/system-network-corewlan-worker.js';

function blockNative() {
	const windows = process.platform === 'win32';
	const name = windows ? 'Sleep' : 'usleep';
	const library = dlopen(windows ? 'kernel32.dll' : process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
		[name]: { args: [FFIType.u32], returns: windows ? FFIType.void : FFIType.i32 },
	});
	library.symbols[name](windows ? 300 : 300000);
	library.close();
}

self.onmessage = ({ data }) => {
	if (data.mode === 'error') throw new Error('worker failure');
	if (data.mode === 'empty-close') return process.exit(0);
	if (data.mode === 'silent') return;
	if (data.mode === 'success') return self.postMessage({ result: [] });
	if (data.mode === 'in-flight') beginCoreWlanAssociation(data.phase);
	if (data.mode === 'message-before-close') self.postMessage({ result: [] });
	Atomics.store(data.marker, 0, 1);
	blockNative();
	if (data.mode === 'late-associate') {
		try {
			beginCoreWlanAssociation(data.phase);
			Atomics.store(data.marker, 1, 1);
		} catch {
			Atomics.store(data.marker, 1, -1);
		}
	}
	process.exit(0);
};
