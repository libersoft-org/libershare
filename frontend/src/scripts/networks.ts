import { writable } from 'svelte/store';
import { api } from './api.ts';
import { type NetworkInfo } from '@libershare/shared';

export const networks = writable<NetworkInfo[]>([]);

async function fetchNetworksOnce() {
	try {
		const response = await api.networks.infoAll();
		networks.set(response);
	} catch (error) {
		console.error('Error fetching networks:', error);
		networks.set([]);
	}
}

export async function initNetworks() {
	await fetchNetworksOnce();
	setInterval(async () => {
		await fetchNetworksOnce();
	}, 1000);
}
