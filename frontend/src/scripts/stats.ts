import { writable } from 'svelte/store';
import { api } from './api.ts';

export const stats = writable<{ [key: string]: any }>({});

async function fetchStatsOnce() {
	try {
		let response = await api.getStats();
		response.ts = Date.now();
		stats.set(response);
	}
	catch (error) {
		console.error('Error fetching stats:', error);
	}
}



export async function initStats() {
	await fetchStatsOnce();
	setInterval(async () => {
		await fetchStatsOnce();
	}, 1000);
}

