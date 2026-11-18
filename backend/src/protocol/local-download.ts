import { CodedError, ErrorCodes, validateLISHStructure, type IStoredLISH } from '@shared';
import { isBusy } from '../api/busy.ts';
import { type DataServer } from '../lish/data-server.ts';
import { conservativeDatasetRoot, datasetRootPath } from '../lish/dataset-root.ts';
import { validateImportedLISH } from '../lish/lish.ts';
import { verifyManifestSignature } from '../lish/manifest-signature.ts';
import { openDataset, type DatasetRoot } from '../lish/safe-dataset-files.ts';
import { Utils } from '../utils.ts';
import { getMaxChunkSize, toManifest } from './lish-protocol.ts';

export async function readLocalDownload(lishPath: string): Promise<{ lish: IStoredLISH; publisher: string | null }> {
	const content = await Bun.file(lishPath).text();
	const lish = validateImportedLISH(Utils.safeJSONParse(content, `LISH file: ${lishPath}`));
	validateLISHStructure(lish, getMaxChunkSize());
	const signature = await verifyManifestSignature(lish);
	return signature.signed ? { lish: toManifest(lish), publisher: signature.publisher } : { lish, publisher: null };
}

export async function bindSignedDataset(dataServer: DataServer, lish: IStoredLISH, base: string): Promise<{ lish: IStoredLISH; root: DatasetRoot }> {
	const stored = dataServer.get(lish.id);
	if (stored && stored.signature !== lish.signature) throw new CodedError(ErrorCodes.LISH_INVALID_MANIFEST, 'The signed file does not match the stored manifest for this ID');
	if (isBusy(lish.id)) throw new CodedError(ErrorCodes.DOWNLOAD_ERROR, 'The stored LISH is busy');
	if (stored?.directory) {
		// Keep the file order and root the existing chunk slots refer to.
		return { lish: stored, root: dataServer.getDatasetRoot(lish.id) ?? conservativeDatasetRoot(stored.directory) };
	}

	const parent = await openDataset({ kind: 'explicit', path: base }, true);
	await parent.close();
	const root: DatasetRoot = { kind: 'derived', base, component: crypto.randomUUID() };
	const dataset = { ...lish, directory: datasetRootPath(root) };
	dataServer.addDataset(dataset, root, undefined, { requireNew: !stored });
	return { lish: dataset, root };
}
