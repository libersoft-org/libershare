import { FFIType, type Library } from 'bun:ffi';
import { loadSystemLibrary } from '../library.ts';

const symbols = {
	pa_mainloop_new: { args: [], returns: FFIType.ptr },
	pa_mainloop_get_api: { args: [FFIType.ptr], returns: FFIType.ptr },
	pa_mainloop_iterate: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
	pa_mainloop_free: { args: [FFIType.ptr], returns: FFIType.void },
	pa_context_new: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.ptr },
	pa_context_connect: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
	pa_context_get_state: { args: [FFIType.ptr], returns: FFIType.i32 },
	pa_context_disconnect: { args: [FFIType.ptr], returns: FFIType.void },
	pa_context_unref: { args: [FFIType.ptr], returns: FFIType.void },
	pa_context_get_server_info: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	pa_context_get_sink_info_by_name: { args: [FFIType.ptr, FFIType.cstring, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	pa_context_set_sink_volume_by_name: { args: [FFIType.ptr, FFIType.cstring, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	pa_context_set_subscribe_callback: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	pa_context_subscribe: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	pa_operation_get_state: { args: [FFIType.ptr], returns: FFIType.i32 },
	pa_context_set_state_callback: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	pa_operation_cancel: { args: [FFIType.ptr], returns: FFIType.void },
	pa_operation_unref: { args: [FFIType.ptr], returns: FFIType.void },
	pa_cvolume_set: { args: [FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.ptr },
} as const;

export type PulseSymbols = Library<typeof symbols>['symbols'];
let library: Library<typeof symbols> | undefined;
export function loadPulse(): PulseSymbols {
	return (library ??= loadSystemLibrary('libpulse.so.0', symbols)).symbols;
}
