import { writable } from 'svelte/store';
import { api } from './api.ts';
import { apiURL } from './ws-client.ts';

export const localFilesystem = writable(true);

function isTauri(): boolean {
	return typeof window !== 'undefined' && !!(window as any).__BACKEND_PORT__;
}

export async function detectLocalFilesystem(): Promise<void> {
	if (isTauri()) { localFilesystem.set(true); return; }
	try {
		const info = await api.fs.info();
		localFilesystem.set(info.localFilesystem);
	} catch {
		try {
			const host = new URL(apiURL).hostname;
			localFilesystem.set(host === 'localhost' || host === '127.0.0.1' || host === '::1');
		} catch {
			localFilesystem.set(true);
		}
	}
}
