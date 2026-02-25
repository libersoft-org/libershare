import { type Networks } from '../lishnet/networks.ts';
import { type DataServer } from '../lish/data-server.ts';
import { Downloader } from '../protocol/downloader.ts';
import { join } from 'path';

type P = Record<string, any>;
type EmitFn = (client: any, event: string, data: any) => void;

export function initTransferHandlers(networks: Networks, dataServer: DataServer, dataDir: string, emit: EmitFn) {
	const download = async (p: P, client: any) => {
		/*
		todo:
		// replace this with setDownloadEnabled(lishID, networkID, enabled)
		//  can a dataset be associated with multiple networks, for download and for upload?
		//  split state of Downloader runtime object from the dataset state (initializing = creating directory structure, ...)
		//  re-create Downloader objects on app start /// or on network association // dissociation?
		 */
		const network = networks.getNetwork();
		if (!network.isRunning()) throw new Error('Network not running');
		const downloadDir = join(dataDir, 'downloads', Date.now().toString());
		const downloader = new Downloader(downloadDir, network, dataServer, p.networkID);
		await downloader.init(p.lishPath);
		downloader
			.download()
			.then(() => emit(client, 'transfer.download:complete', { downloadDir }))
			.catch(err => emit(client, 'transfer.download:error', { error: err.message }));
		return { downloadDir };
	};

	return { download };
}
