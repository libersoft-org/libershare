import { CString, FFIType, ptr, read, type Library, type Pointer } from 'bun:ffi';
import { loadSystemLibrary } from '../library.ts';
import { DBusError, SystemBus } from './dbus.ts';

const symbols = {
	g_file_new_for_path: { args: [FFIType.ptr], returns: FFIType.ptr },
	g_file_get_uri: { args: [FFIType.ptr], returns: FFIType.ptr },
	g_app_info_launch_default_for_uri: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	g_object_unref: { args: [FFIType.ptr], returns: FFIType.void },
	g_free: { args: [FFIType.ptr], returns: FFIType.void },
	g_error_free: { args: [FFIType.ptr], returns: FFIType.void },
} as const;
let library: Library<typeof symbols> | undefined;
export interface LinuxOpenRequest {
	path: string;
	environment: Record<string, string>;
	timeoutMs: number;
}

export function displayEnvironment(environment: Record<string, string | undefined>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY']) if (environment[key]) result[key] = environment[key]!;
	return result;
}

export async function openLinuxPath(request: LinuxOpenRequest): Promise<void> {
	const environment = displayEnvironment(request.environment);
	if (!environment['DISPLAY'] && !environment['WAYLAND_DISPLAY']) throw new Error('Opening local files requires a graphical session');
	if (!request.path.startsWith('/') || request.path.includes('\0')) throw new Error('Invalid local path');
	if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) throw new Error('Invalid open timeout');
	const deadline = performance.now() + Math.min(10000, request.timeoutMs);
	const bus = new SystemBus({ bus: 'user' });
	try {
		const reply = await bus.call({ kind: 'read', destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'UpdateActivationEnvironment', signature: 'a{ss}', args: [environment], timeoutUsec: BigInt(Math.max(1, Math.floor((deadline - performance.now()) * 1000))) });
		if (reply.type === 'error') throw new DBusError(reply);
	} finally {
		bus.close();
	}
	if (performance.now() >= deadline) throw new Error('Opening local file timed out');
	const gio = (library ??= loadSystemLibrary('libgio-2.0.so.0', symbols)).symbols;
	const path = Buffer.from(request.path + '\0');
	const file = gio.g_file_new_for_path(ptr(path));
	if (!file) throw new Error('GIO could not create the local file reference');
	let uri: Pointer | null = null;
	const error = new BigUint64Array(1);
	try {
		uri = (Number(gio.g_file_get_uri(file)) as Pointer) || null;
		if (!uri) throw new Error('GIO could not create the file URI');
		const success = gio.g_app_info_launch_default_for_uri(uri, null, ptr(error));
		if (!success) {
			const message = error[0] ? read.ptr(Number(error[0]) as Pointer, 8) : 0;
			throw new Error(message ? new CString(message as Pointer).toString() : 'GIO could not launch the file handler');
		}
	} finally {
		if (error[0]) gio.g_error_free(Number(error[0]) as Pointer);
		if (uri) gio.g_free(uri);
		gio.g_object_unref(file);
	}
}
