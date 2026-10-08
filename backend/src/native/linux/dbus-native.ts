import { type Library, type Pointer } from 'bun:ffi';
import { loadSystemLibrary } from '../library.ts';

const symbols = {
	sd_bus_open_system: { args: ['ptr'], returns: 'i32' },
	sd_bus_open_user: { args: ['ptr'], returns: 'i32' },
	sd_bus_get_unique_name: { args: ['ptr', 'ptr'], returns: 'i32' },
	sd_bus_close_unref: { args: ['ptr'], returns: 'ptr' },
	sd_bus_set_allow_interactive_authorization: { args: ['ptr', 'i32'], returns: 'i32' },
	sd_bus_message_new_method_call: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
	sd_bus_message_new_signal: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
	sd_bus_message_new_method_return: { args: ['ptr', 'ptr'], returns: 'i32' },
	sd_bus_message_new_method_error: { args: ['ptr', 'ptr', 'ptr'], returns: 'i32' },
	sd_bus_message_ref: { args: ['ptr'], returns: 'ptr' },
	sd_bus_message_unref: { args: ['ptr'], returns: 'ptr' },
	sd_bus_message_append_basic: { args: ['ptr', 'i8', 'ptr'], returns: 'i32' },
	sd_bus_message_open_container: { args: ['ptr', 'i8', 'ptr'], returns: 'i32' },
	sd_bus_message_close_container: { args: ['ptr'], returns: 'i32' },
	sd_bus_message_peek_type: { args: ['ptr', 'ptr', 'ptr'], returns: 'i32' },
	sd_bus_message_read_basic: { args: ['ptr', 'i8', 'ptr'], returns: 'i32' },
	sd_bus_message_enter_container: { args: ['ptr', 'i8', 'ptr'], returns: 'i32' },
	sd_bus_message_exit_container: { args: ['ptr'], returns: 'i32' },
	sd_bus_message_seal: { args: ['ptr', 'u64', 'u64'], returns: 'i32' },
	sd_bus_message_rewind: { args: ['ptr', 'i32'], returns: 'i32' },
	sd_bus_call_async: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'u64'], returns: 'i32' },
	sd_bus_add_match: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
	sd_bus_add_object: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
	sd_bus_send: { args: ['ptr', 'ptr', 'ptr'], returns: 'i32' },
	sd_bus_get_n_queued_write: { args: ['ptr', 'ptr'], returns: 'i32' },
	sd_bus_slot_unref: { args: ['ptr'], returns: 'ptr' },
	sd_bus_process: { args: ['ptr', 'ptr'], returns: 'i32' },
	sd_bus_message_get_sender: { args: ['ptr'], returns: 'ptr' },
	sd_bus_message_get_path: { args: ['ptr'], returns: 'ptr' },
	sd_bus_message_get_interface: { args: ['ptr'], returns: 'ptr' },
	sd_bus_message_get_member: { args: ['ptr'], returns: 'ptr' },
	sd_bus_message_get_error: { args: ['ptr'], returns: 'ptr' },
	sd_bus_message_get_signature: { args: ['ptr', 'i32'], returns: 'ptr' },
	sd_bus_message_get_type: { args: ['ptr', 'ptr'], returns: 'i32' },
} as const;

export type SdBusSymbols = Library<typeof symbols>['symbols'];
let library: Library<typeof symbols> | undefined;

export function loadSdBus(): SdBusSymbols {
	library ??= loadSystemLibrary('libsystemd.so.0', symbols);
	return library.symbols;
}

export function nativePointer(value: bigint | number): Pointer {
	if (!value) throw new Error('sd-bus returned a null pointer');
	return Number(value) as Pointer;
}

export function checkSdBus(result: number, operation: string): number {
	if (result < 0) throw new Error(`${operation} failed: errno ${-result}`);
	return result;
}
