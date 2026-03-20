import { writable } from 'svelte/store';
import { api } from './api.ts';
import type { SystemRAMInfo } from '@shared';
export const ramInfo = writable<SystemRAMInfo>({ used: 0, total: 0 });

export async function initSystemStats(): Promise<void> {
	api.on('system:ram', (data: SystemRAMInfo) => {
		ramInfo.set(data);
	});
	api.subscribe('system:ram');
	ramInfo.set(await api.call<SystemRAMInfo>('system.ram'));
}
