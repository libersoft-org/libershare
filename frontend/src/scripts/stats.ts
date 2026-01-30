import { writable } from 'svelte/store';
import { api } from './api.ts';

export const stats = writable<{ [key: string]: any }>({});

async function fetchStatsOnce() {
	try {
		const response = await api.getStats();
		stats.set({ ...response, ts: Date.now() });
	} catch (error) {
		console.error('Error fetching stats:', error);
		stats.set({ error: 'Error fetching stats', ts: Date.now() });
	}
}

export async function initStats() {
	await fetchStatsOnce();
	setInterval(async () => {
		await fetchStatsOnce();
	}, 1000);
}
