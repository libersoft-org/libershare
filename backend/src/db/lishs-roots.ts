import type { Database } from 'bun:sqlite';
import { CodedError, ErrorCodes, type IStoredLISH } from '@shared';
import type { DatasetRoot } from '../lish/safe-dataset-files.ts';
import { isAbsolute } from 'node:path';
import { datasetRootPath } from '../lish/dataset-root.ts';
import { addLISH, type AddLISHOptions } from './lishs.ts';
import { replaceDatasetLinkBindings, type DatasetLinkBinding } from './lishs-link-bindings.ts';

function validatedRoot(value: unknown): DatasetRoot {
	if (value && typeof value === 'object') {
		const root = value as Record<string, unknown>;
		if (root['kind'] === 'explicit' && typeof root['path'] === 'string' && isAbsolute(root['path']) && !root['path'].includes('\0')) return { kind: 'explicit', path: root['path'] };
		if (root['kind'] === 'derived' && typeof root['base'] === 'string' && isAbsolute(root['base']) && !root['base'].includes('\0') && typeof root['component'] === 'string' && root['component'] !== '' && root['component'] !== '.' && root['component'] !== '..' && !/[\\/\x00-\x1f:]/u.test(root['component'])) {
			return { kind: 'derived', base: root['base'], component: root['component'] };
		}
	}
	throw new CodedError(ErrorCodes.LISH_UNSAFE_PATH, 'Invalid local dataset root');
}

/** Root choices are local state and never come from an imported manifest. */
export function setDatasetRoot(db: Database, lishID: string, root: DatasetRoot | null, final = false): void {
	if (root === null) {
		db.run('DELETE FROM lishs_roots WHERE lish_id = ? AND is_final = ?', [lishID, Number(final)]);
		return;
	}
	const value = JSON.stringify(validatedRoot(root));
	db.run('INSERT INTO lishs_roots (lish_id, is_final, root) VALUES (?, ?, ?) ON CONFLICT(lish_id, is_final) DO UPDATE SET root = excluded.root', [lishID, Number(final), value]);
}

export function getDatasetRoot(db: Database, lishID: string, final = false): DatasetRoot | null {
	const row = db.query<{ root: string }, [string, number]>('SELECT root FROM lishs_roots WHERE lish_id = ? AND is_final = ?').get(lishID, Number(final));
	if (!row) return null;
	try {
		return validatedRoot(JSON.parse(row.root));
	} catch {
		throw new CodedError(ErrorCodes.LISH_UNSAFE_PATH, 'Invalid stored dataset root');
	}
}

export function addDataset(db: Database, lish: IStoredLISH, root: DatasetRoot, finalRoot?: DatasetRoot, options: AddLISHOptions = {}): void {
	db.transaction(() => {
		addLISH(db, lish, options);
		replaceDatasetLinkBindings(db, lish.id, []);
		setDatasetRoot(db, lish.id, root);
		setDatasetRoot(db, lish.id, finalRoot ?? null, true);
	})();
}

/** Directory and authority move together, so failed commits can safely discard the copy. */
export function relocateDataset(db: Database, lishID: string, root: DatasetRoot, clearFinal = false, bindings?: readonly DatasetLinkBinding[]): void {
	const checked = validatedRoot(root);
	db.transaction(() => {
		const result = db.run('UPDATE lishs SET directory = ? WHERE lish_id = ?', [datasetRootPath(checked), lishID]);
		if (!result.changes) throw new CodedError(ErrorCodes.LISH_NOT_FOUND, lishID);
		setDatasetRoot(db, lishID, checked);
		if (bindings !== undefined) replaceDatasetLinkBindings(db, lishID, bindings);
		if (clearFinal) {
			db.run('UPDATE lishs SET final_directory = NULL WHERE lish_id = ?', [lishID]);
			setDatasetRoot(db, lishID, null, true);
		}
	})();
}
