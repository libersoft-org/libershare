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
