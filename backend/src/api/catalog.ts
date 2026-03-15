import { type CatalogManager } from '../catalog/catalog-manager.ts';
import { Utils } from '../utils.ts';
import type { CatalogEntryRow, CatalogACLRow } from '../db/catalog.ts';

const assert = Utils.assertParams;

export interface CatalogHandlers {
	list: (p: { networkID: string; limit?: number }) => CatalogEntryRow[];
	get: (p: { networkID: string; lishID: string }) => CatalogEntryRow | null;
	search: (p: { networkID: string; query: string; limit?: number }) => CatalogEntryRow[];
	publish: (p: {
		networkID: string; lishID: string; name?: string; description?: string;
		chunkSize: number; checksumAlgo: string; totalSize: number; fileCount: number;
		manifestHash: string; contentType?: string; tags?: string[];
	}) => Promise<void>;
	update: (p: { networkID: string; lishID: string; name?: string; description?: string; contentType?: string; tags?: string[] }) => Promise<void>;
	remove: (p: { networkID: string; lishID: string }) => Promise<void>;
	getAccess: (p: { networkID: string }) => CatalogACLRow | null;
	grantRole: (p: { networkID: string; delegatee: string; role: 'admin' | 'moderator' }) => Promise<void>;
	revokeRole: (p: { networkID: string; delegatee: string; role: 'admin' | 'moderator' }) => Promise<void>;
}

export function initCatalogHandlers(catalogManager: CatalogManager): CatalogHandlers {
	return {
		list(p) {
			assert(p, ['networkID']);
			return catalogManager.list(p.networkID, p.limit);
		},
		get(p) {
			assert(p, ['networkID', 'lishID']);
			return catalogManager.get(p.networkID, p.lishID);
		},
		search(p) {
			assert(p, ['networkID', 'query']);
			return catalogManager.search(p.networkID, p.query, p.limit);
		},
		async publish(p) {
			assert(p, ['networkID', 'lishID', 'chunkSize', 'checksumAlgo', 'totalSize', 'fileCount', 'manifestHash']);
			await catalogManager.publish(p.networkID, p);
		},
		async update(p) {
			assert(p, ['networkID', 'lishID']);
			const fields: { name?: string; description?: string; contentType?: string; tags?: string[] } = {};
			if (p.name !== undefined) fields.name = p.name;
			if (p.description !== undefined) fields.description = p.description;
			if (p.contentType !== undefined) fields.contentType = p.contentType;
			if (p.tags !== undefined) fields.tags = p.tags;
			await catalogManager.update(p.networkID, p.lishID, fields);
		},
		async remove(p) {
			assert(p, ['networkID', 'lishID']);
			await catalogManager.remove(p.networkID, p.lishID);
		},
		getAccess(p) {
			assert(p, ['networkID']);
			return catalogManager.getAccess(p.networkID);
		},
		async grantRole(p) {
			assert(p, ['networkID', 'delegatee', 'role']);
			await catalogManager.grantRole(p.networkID, p.delegatee, p.role);
		},
		async revokeRole(p) {
			assert(p, ['networkID', 'delegatee', 'role']);
			await catalogManager.revokeRole(p.networkID, p.delegatee, p.role);
		},
	};
}
