import { CodedError, ErrorCodes, isVerifiedLISH, validateLISHStructure, type IStoredLISH } from '@shared';
import { resolve } from 'node:path';
import { isBusy } from '../api/busy.ts';
import { type DataServer } from '../lish/data-server.ts';
import { conservativeDatasetRoot, datasetRootPath } from '../lish/dataset-root.ts';
import { validateImportedLISH } from '../lish/lish.ts';
import { ManifestAdmission } from '../lish/manifest-admission.ts';
import { openDataset, type DatasetRoot } from '../lish/safe-dataset-files.ts';
import { Utils } from '../utils.ts';
import { getMaxChunkSize, toManifest } from './lish-protocol.ts';

/**
 * Read the manifest a download starts from. A manifest that is not verified is refused unless the
 * user already agreed (`acceptUnverified`); it is then downloaded as an unsigned one.
 */
export async function readLocalDownload(lishPath: string, acceptUnverified = false): Promise<{ lish: IStoredLISH; publisher: string | null }> {
	const content = await Bun.file(lishPath).text();
	const lish = validateImportedLISH(Utils.safeJSONParse(content, `LISH file: ${lishPath}`));
	validateLISHStructure(lish, getMaxChunkSize());
	const checks = await ManifestAdmission.gate(lish, acceptUnverified);
	return isVerifiedLISH(checks) ? { lish: toManifest(lish), publisher: lish.publisher! } : { lish: ManifestAdmission.storable(lish, checks), publisher: null };
}

export async function bindSignedDataset(dataServer: DataServer, lish: IStoredLISH, base: string): Promise<{ lish: IStoredLISH; root: DatasetRoot }> {
	const stored = dataServer.get(lish.id);
	if (stored && stored.signature !== lish.signature) throw new CodedError(ErrorCodes.LISH_INVALID_MANIFEST, 'The signed file does not match the stored manifest for this ID');
	if (isBusy(lish.id)) throw new CodedError(ErrorCodes.DOWNLOAD_ERROR, 'The stored LISH is busy');
	if (stored?.directory) {
		const root = dataServer.getDatasetRoot(lish.id);
		if (root?.kind !== 'derived' || resolve(root.base) !== resolve(base) || datasetRootPath(root) !== resolve(stored.directory)) {
			throw new CodedError(ErrorCodes.LISH_UNSAFE_PATH, 'The stored dataset is outside the managed download directory');
		}
		return { lish: stored, root };
	}

	const parent = await openDataset({ kind: 'explicit', path: base }, true);
	await parent.close();
	const root: DatasetRoot = { kind: 'derived', base, component: crypto.randomUUID() };
	const finalDirectory = stored?.finalDirectory;
	const finalRoot = finalDirectory ? (dataServer.getDatasetRoot(lish.id, true) ?? conservativeDatasetRoot(finalDirectory)) : undefined;
	const dataset = { ...lish, directory: datasetRootPath(root), ...(finalDirectory ? { finalDirectory } : {}) };
	dataServer.addDataset(dataset, root, finalRoot, { requireNew: !stored });
	return { lish: dataset, root };
}
