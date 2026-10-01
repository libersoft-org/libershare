import { CodedError, ErrorCodes, sanitizeFilename, type ILISH } from '@shared';
import { basename, dirname, join, resolve } from 'node:path';
import type { DatasetRoot } from './safe-dataset-files.ts';

/** Older local paths do not authorize following a link at the dataset root. */
export function conservativeDatasetRoot(directory: string): DatasetRoot {
	const path = resolve(directory);
	if (dirname(path) === path) throw new CodedError(ErrorCodes.LISH_UNSAFE_PATH, 'Select a dataset directory');
	return { kind: 'derived', base: dirname(path), component: basename(path) };
}

export function datasetRootPath(root: DatasetRoot): string {
	return root.kind === 'explicit' ? resolve(root.path) : resolve(join(root.base, root.component));
}

export function datasetRootName(lish: Pick<ILISH, 'name' | 'id'>): string {
	const name = sanitizeFilename(lish.name ?? lish.id);
	const device = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?: *\.|$)/i;
	if (!name || name === '.' || name === '..' || /[. ]$/.test(name) || device.test(name)) {
		throw new CodedError(ErrorCodes.LISH_UNSAFE_PATH, 'The dataset root must have a safe directory name');
	}
	return name;
}
