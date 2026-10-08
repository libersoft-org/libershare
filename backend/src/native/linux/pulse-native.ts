import { type Library } from 'bun:ffi';
import { loadSystemLibrary } from '../library.ts';

const symbols = {
	pa_mainloop_new: { args: [], returns: 'ptr' },
	pa_mainloop_get_api: { args: ['ptr'], returns: 'ptr' },
	pa_mainloop_iterate: { args: ['ptr', 'i32', 'ptr'], returns: 'i32' },
	pa_mainloop_free: { args: ['ptr'], returns: 'void' },
	pa_context_new: { args: ['ptr', 'cstring'], returns: 'ptr' },
	pa_context_connect: { args: ['ptr', 'ptr', 'i32', 'ptr'], returns: 'i32' },
	pa_context_get_state: { args: ['ptr'], returns: 'i32' },
	pa_context_disconnect: { args: ['ptr'], returns: 'void' },
	pa_context_unref: { args: ['ptr'], returns: 'void' },
	pa_context_get_server_info: { args: ['ptr', 'ptr', 'ptr'], returns: 'ptr' },
	pa_context_get_sink_info_by_name: { args: ['ptr', 'cstring', 'ptr', 'ptr'], returns: 'ptr' },
	pa_context_set_sink_volume_by_name: { args: ['ptr', 'cstring', 'ptr', 'ptr', 'ptr'], returns: 'ptr' },
	pa_context_set_subscribe_callback: { args: ['ptr', 'ptr', 'ptr'], returns: 'void' },
	pa_context_subscribe: { args: ['ptr', 'u32', 'ptr', 'ptr'], returns: 'ptr' },
	pa_operation_get_state: { args: ['ptr'], returns: 'i32' },
	pa_context_set_state_callback: { args: ['ptr', 'ptr', 'ptr'], returns: 'void' },
	pa_operation_cancel: { args: ['ptr'], returns: 'void' },
	pa_operation_unref: { args: ['ptr'], returns: 'void' },
	pa_cvolume_set: { args: ['ptr', 'u32', 'u32'], returns: 'ptr' },
} as const;

export type PulseSymbols = Library<typeof symbols>['symbols'];
let library: Library<typeof symbols> | undefined;
export function loadPulse(): PulseSymbols {
	return (library ??= loadSystemLibrary('libpulse.so.0', symbols)).symbols;
}
