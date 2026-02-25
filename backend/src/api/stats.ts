import { type Networks } from '../lishnet/networks.ts';
import { type DataServer } from '../lish/data-server.ts';

export function initStatsHandlers(networks: Networks, dataServer: DataServer) {
	const get = () => {
		const network = networks.getNetwork();
		const allLishs = dataServer.getAllLishs().filter(l => l.directory);
		return {
			networks: {
				total: networks.getAll().length,
				enabled: networks.getEnabled().length,
			},
			peers: network.isRunning() ? network.getPeers().length : 0,
			datasets: {
				total: allLishs.length,
				complete: allLishs.filter(l => dataServer.isComplete(l)).length,
				downloading: allLishs.filter(l => !dataServer.isComplete(l)).length,
			},
			space: [{ path: '/', free: 1000000000, usedByDatabase: 500000000, usedByDatasets: 300000000 }],
			transfers: {
				download: { now: 123, total: 456 },
				upload: { now: 123, total: 456 },
			},
		};
	};

	return { get };
}
