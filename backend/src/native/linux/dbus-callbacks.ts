import { FFIType, JSCallback, ptr, type Pointer } from 'bun:ffi';

interface CallbackTarget {
	readonly token: Uint8Array;
	readonly receive: (message: Pointer) => void;
}

export interface DBusCallback {
	readonly ptr: Pointer;
	readonly userdata: Pointer;
	close(): void;
}

const targets = new Map<Pointer, CallbackTarget>();
let trampoline: JSCallback | undefined;

/** Bun retains native memory after JSCallback.close; reuse one trampoline per worker. */
export function retainDBusCallback(receive: (message: Pointer) => void): DBusCallback {
	trampoline ??= new JSCallback(
		(message: Pointer, userdata: Pointer) => {
			targets.get(userdata)?.receive(message);
			return 0;
		},
		{ args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 }
	);
	const token = new Uint8Array(1);
	const userdata = ptr(token);
	targets.set(userdata, { token, receive });
	return {
		ptr: trampoline.ptr!,
		userdata,
		close: () => {
			targets.delete(userdata);
		},
	};
}
