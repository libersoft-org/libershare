import type { Database } from 'bun:sqlite';

/** Local association established by a copy; not part of the shared manifest. */
export interface DatasetLinkBinding {
	path: string;
	target: string;
	source: string;
	hardlink: boolean;
	materializedIdentity?: string;
}

export function getDatasetLinkBindings(db: Database, lishID: string): DatasetLinkBinding[] {
	return db
		.query<{ path: string; target: string; source: string; hardlink: number; materializedIdentity: string | null }, [string]>('SELECT path, target, source, hardlink, materialized_identity AS materializedIdentity FROM lishs_link_bindings WHERE lish_id = ? ORDER BY path')
		.all(lishID)
		.map(({ materializedIdentity, ...row }) => ({ ...row, hardlink: row.hardlink === 1, ...(materializedIdentity === null ? {} : { materializedIdentity }) }));
}

export function replaceDatasetLinkBindings(db: Database, lishID: string, bindings: readonly DatasetLinkBinding[]): void {
	db.run('DELETE FROM lishs_link_bindings WHERE lish_id = ?', [lishID]);
	for (const binding of bindings) db.run('INSERT INTO lishs_link_bindings (lish_id, path, target, source, hardlink, materialized_identity) VALUES (?, ?, ?, ?, ?, ?)', [lishID, binding.path, binding.target, binding.source, Number(binding.hardlink), binding.materializedIdentity ?? null]);
}
