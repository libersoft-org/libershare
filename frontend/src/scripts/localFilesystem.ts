import { writable } from 'svelte/store';
import { api } from './api.ts';
import { apiURL } from './ws-client.ts';
import { isNativeBackend } from './tauri-transport.ts';

export const localFilesystem = writable(true);

export async function detectLocalFilesystem(): Promise<void> {
	if (isNativeBackend()) {
		localFilesystem.set(true);
		return;
	}
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
