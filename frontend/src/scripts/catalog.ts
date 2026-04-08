import { api } from './api.ts';
import type { CatalogEntryResponse, CatalogACLResponse } from '@shared';
export type { CatalogEntryResponse, CatalogACLResponse };

export async function listCatalogEntries(networkID: string, limit?: number): Promise<CatalogEntryResponse[]> {
	return api.catalog.list(networkID, limit);
}

export async function getCatalogEntry(networkID: string, lishID: string): Promise<CatalogEntryResponse | null> {
	return api.catalog.get(networkID, lishID);
}

export async function searchCatalog(networkID: string, query: string): Promise<CatalogEntryResponse[]> {
	return api.catalog.search(networkID, query);
}

export async function getCatalogAccess(networkID: string): Promise<CatalogACLResponse | null> {
	return api.catalog.getAccess(networkID);
}

export function subscribeCatalogEvents(callbacks: {
	onUpdated?: (data: { networkID: string; entry: CatalogEntryResponse }) => void;
	onRemoved?: (data: { networkID: string; lishID: string }) => void;
	onACL?: (data: { networkID: string; access: CatalogACLResponse }) => void;
	onSync?: (data: { networkID: string; newEntries: number; phase: 'start' | 'complete' }) => void;
}): () => void {
	const unsubs: (() => void)[] = [];
	if (callbacks.onUpdated) {
		const u = api.on('catalog:updated', callbacks.onUpdated);
		if (u) unsubs.push(u);
	}
	if (callbacks.onRemoved) {
		const u = api.on('catalog:removed', callbacks.onRemoved);
		if (u) unsubs.push(u);
	}
	if (callbacks.onACL) {
		const u = api.on('catalog:acl', callbacks.onACL);
		if (u) unsubs.push(u);
	}
	if (callbacks.onSync) {
		const u = api.on('catalog:sync', callbacks.onSync);
		if (u) unsubs.push(u);
	}
	api.subscribe('catalog:updated', 'catalog:removed', 'catalog:acl', 'catalog:sync');
	return () => unsubs.forEach(u => u());
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function parseTags(tagsJson: string | null): string[] {
	if (!tagsJson) return [];
	try { return JSON.parse(tagsJson) as string[]; } catch { return []; }
}

export async function grantCatalogRole(networkID: string, delegatee: string, role: 'admin' | 'moderator'): Promise<void> {
	return api.catalog.grantRole(networkID, delegatee, role);
}

export async function revokeCatalogRole(networkID: string, delegatee: string, role: 'admin' | 'moderator'): Promise<void> {
	return api.catalog.revokeRole(networkID, delegatee, role);
}

export async function publishCatalogEntry(networkID: string, params: {
	lishID: string; name?: string; description?: string;
	chunkSize: number; checksumAlgo: string; totalSize: number;
	fileCount: number; manifestHash: string; contentType?: string; tags?: string[];
}): Promise<void> {
	return api.catalog.publish(networkID, params);
}

export async function updateCatalogEntry(networkID: string, lishID: string, fields: {
	name?: string; description?: string; contentType?: string; tags?: string[];
}): Promise<void> {
	return api.catalog.update(networkID, lishID, fields);
}

export async function removeCatalogEntry(networkID: string, lishID: string): Promise<void> {
	return api.catalog.remove(networkID, lishID);
}
