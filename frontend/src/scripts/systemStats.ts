import { writable } from 'svelte/store';
import { api } from './api.ts';
import type { SystemRAMInfo, SystemStorageInfo, SystemCPUInfo } from '@shared';
export const ramInfo = writable<SystemRAMInfo>({ used: 0, total: 0 });
export const storageInfo = writable<SystemStorageInfo>({ used: 0, total: 0 });
export const cpuInfo = writable<SystemCPUInfo>({ usage: 0 });

let handlersRegistered = false;

export async function initSystemStats(): Promise<void> {
	if (!handlersRegistered) {
		handlersRegistered = true;
		api.on('system:ram', (data: SystemRAMInfo) => {
			ramInfo.set(data);
		});
		api.on('system:storage', (data: SystemStorageInfo) => {
			storageInfo.set(data);
		});
		api.on('system:cpu', (data: SystemCPUInfo) => {
			cpuInfo.set(data);
		});
	}
	api.subscribe('system:ram');
	api.subscribe('system:storage');
	api.subscribe('system:cpu');
	ramInfo.set(await api.call<SystemRAMInfo>('system.ram'));
	api
		.call<SystemStorageInfo>('system.storage')
		.then(data => storageInfo.set(data))
		.catch(() => {});
}
