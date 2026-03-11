import { type Networks } from '../lishnet/lishnets.ts';
import { type DataServer } from '../lish/data-server.ts';
import { type DownloadResponse, CodedError, ErrorCodes } from '@shared';
import { Downloader } from '../protocol/downloader.ts';
import { join } from 'path';
import { Utils } from '../utils.ts';
const assert = Utils.assertParams;
type EmitFn = (client: any, event: string, data: any) => void;

interface TransferHandlers {
	download: (p: { networkID: string; lishPath: string }, client: any) => Promise<DownloadResponse>;
}

export function initTransferHandlers(networks: Networks, dataServer: DataServer, dataDir: string, emit: EmitFn): TransferHandlers {
	async function download(p: { networkID: string; lishPath: string }, client: any): Promise<DownloadResponse> {
		assert(p, ['networkID', 'lishPath']);
		/*
		TODO:
		// replace this with setDownloadEnabled(lishID, networkID, enabled)
		//  can a dataset be associated with multiple networks, for download and for upload?
		//  split state of Downloader runtime object from the dataset state (initializing = creating directory structure, ...)
		//  re-create Downloader objects on app start /// or on network association // dissociation?
		 */
		const network = networks.getRunningNetwork();
		const downloadDir = join(dataDir, 'downloads', Date.now().toString());
		const downloader = new Downloader(downloadDir, network, dataServer, p.networkID);
		await downloader.init(p.lishPath);
		downloader
			.download()
			.then(() => emit(client, 'transfer.download:complete', { downloadDir }))
			.catch(err => {
				if (err instanceof CodedError) emit(client, 'transfer.download:error', { error: err.code, errorDetail: err.detail });
				else emit(client, 'transfer.download:error', { error: ErrorCodes.DOWNLOAD_ERROR, errorDetail: err.message });
			});
		return { downloadDir };
	}
	return { download };
}
