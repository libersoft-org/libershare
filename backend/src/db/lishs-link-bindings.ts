import type { Database } from 'bun:sqlite';

/** Local association established by a copy; not part of the shared manifest. */
export interface DatasetLinkBinding {
 path: string;
 target: string;
 source: string;
 hardlink: boolean;
}

export function getDatasetLinkBindings(db: Database, lishID: string): DatasetLinkBinding[] {
 return db.query<{ path: string; target: string; source: string; hardlink: number }, [string]>(
  'SELECT path, target, source, hardlink FROM lishs_link_bindings WHERE lish_id = ? ORDER BY path'
 ).all(lishID).map(row => ({ ...row, hardlink: row.hardlink === 1 }));
}

export function replaceDatasetLinkBindings(db: Database, lishID: string, bindings: readonly DatasetLinkBinding[]): void {
 db.run('DELETE FROM lishs_link_bindings WHERE lish_id = ?', [lishID]);
 for (const binding of bindings) db.run(
  'INSERT INTO lishs_link_bindings (lish_id, path, target, source, hardlink) VALUES (?, ?, ?, ?, ?)',
  [lishID, binding.path, binding.target, binding.source, Number(binding.hardlink)]
 );
}
