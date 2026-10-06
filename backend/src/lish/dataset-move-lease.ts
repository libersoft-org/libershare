import { dlopen, FFIType, read } from 'bun:ffi';

const SET_LEASE = 1024;
const GET_LEASE = 1025;
const WRITE_LEASE = 1;
const UNLOCK_LEASE = 2;

let fcntl: ReturnType<typeof load> | undefined;
let interrupted = 0;
function load() {
	if (process.platform !== 'linux') throw Object.assign(new Error('Exclusive file leases are unavailable'), { code: 'FS_MOVE_UNSUPPORTED' });
	// Linux leases notify their holder through SIGIO before a conflicting open can proceed.
	process.on('SIGIO', () => {
		interrupted++;
	});
	return dlopen('libc.so.6', { fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 }, __errno_location: { args: [], returns: FFIType.ptr } }).symbols;
}

/** Existing descriptors must be excluded before a copied source can be removed. */
export function acquireMoveLease(fd: number, links: number): { check(): void; close(): void } {
	if (links !== 1) throw Object.assign(new Error('A copied source has other hardlinks'), { code: 'FS_MOVE_UNSUPPORTED' });
	const native = (fcntl ??= load());
	const call = native.fcntl;
	if (call(fd, SET_LEASE, WRITE_LEASE) !== 0) {
		const address = native.__errno_location();
		const errno = address === null ? 0 : read.i32(address);
		throw Object.assign(new Error('Cannot acquire an exclusive source lease'), { code: errno === 11 ? 'FS_BUSY' : 'FS_MOVE_UNSUPPORTED' });
	}
	const epoch = interrupted;
	return {
		check() {
			if (epoch !== interrupted || call(fd, GET_LEASE, 0) !== WRITE_LEASE) throw Object.assign(new Error('Source lease was interrupted'), { code: 'FS_BUSY' });
		},
		close() {
			call(fd, SET_LEASE, UNLOCK_LEASE);
		},
	};
}
