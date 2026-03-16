import { WebSocketServer, type WebSocket } from 'ws';

const PORT = 1158;

const DEFAULT_SETTINGS = {
	language: '',
	ui: {
		cursorSize: 'medium' as const,
		footerVisible: true,
		footerPosition: 'right' as const,
		footerWidgets: {
			version: false,
			download: true,
			upload: true,
			cpu: false,
			ram: false,
			storage: false,
			lishStatus: true,
			connection: true,
			volume: true,
			clock: true,
		},
		timeFormat24h: true,
		showSeconds: false,
	},
	audio: {
		enabled: true,
		volume: 50,
	},
	storage: {
		downloadPath: '~/LiberShare/finished/',
		tempPath: '~/LiberShare/temp/',
		lishPath: '~/LiberShare/lish/',
		lishnetPath: '~/LiberShare/lishnet/',
	},
	network: {
		incomingPort: 9090,
		maxDownloadConnections: 200,
		maxUploadConnections: 200,
		maxDownloadSpeed: 0,
		maxUploadSpeed: 0,
		allowRelay: true,
		maxRelayReservations: 0,
		autoStartSharing: true,
		announceAddresses: [],
	},
	system: {
		autoStartOnBoot: true,
		showInTray: true,
		minimizeToTray: true,
	},
	export: {
		minifyJson: false,
		compressGzip: false,
	},
	input: {
		initialDelay: 400,
		repeatDelay: 150,
		gamepadDeadzone: 0.5,
	},
};

type RpcHandler = (params: Record<string, unknown>) => unknown;

const handlers: Record<string, RpcHandler> = {
	'settings.list': () => structuredClone(DEFAULT_SETTINGS),
	'settings.getDefaults': () => structuredClone(DEFAULT_SETTINGS),
	'settings.get': () => structuredClone(DEFAULT_SETTINGS),
	'settings.set': () => true,
	'settings.reset': () => structuredClone(DEFAULT_SETTINGS),
	'lishnets.list': () => [{
		networkID: 'net-test', name: 'Test Network', description: 'Mock test network',
		bootstrapPeers: [], enabled: true, created: '2026-01-01T00:00:00Z',
		ownerPeerID: '12D3KooWTestOwnerPeerID000000000000000000000000',
	}],
	'lishnets.infoAll': () => [],
	'lishnets.getNodeInfo': () => ({
		peerID: '12D3KooWTestOwnerPeerID000000000000000000000000',
		addresses: ['/ip4/127.0.0.1/tcp/9090'],
	}),
	'lishs.list': () => ({ items: [], verifying: null, pendingVerification: [] }),
	'datasets.getDatasets': () => [],
	'events.subscribe': () => true,
	'events.unsubscribe': () => true,
	'fs.info': () => ({ platform: 'linux', separator: '/', home: '/home/test', roots: ['/'] }),
	'fs.list': () => ({ path: '/', entries: [] }),
	// Catalog API handlers
	'catalog.list': () => MOCK_CATALOG_ENTRIES,
	'catalog.get': (params) => MOCK_CATALOG_ENTRIES.find(e => e.lish_id === params['lishID']) ?? null,
	'catalog.search': (params) => {
		const q = (params['query'] as string || '').toLowerCase();
		if (q.startsWith('#')) {
			const tag = q.slice(1);
			return MOCK_CATALOG_ENTRIES.filter(e => e.tags?.includes(tag));
		}
		return MOCK_CATALOG_ENTRIES.filter(e =>
			e.name?.toLowerCase().includes(q) || e.description?.toLowerCase().includes(q)
		);
	},
	'catalog.publish': () => undefined,
	'catalog.update': () => undefined,
	'catalog.remove': () => undefined,
	'catalog.getAccess': () => ({
		network_id: 'net-test',
		owner: '12D3KooWTestOwnerPeerID000000000000000000000000',
		admins: ['12D3KooWTestAdmin1PeerID00000000000000000000000'],
		moderators: ['12D3KooWTestMod1PeerID000000000000000000000000', '12D3KooWTestMod2PeerID000000000000000000000000'],
		restrict_writes: 1,
	}),
	'catalog.grantRole': () => undefined,
	'catalog.revokeRole': () => undefined,
	'catalog.getSyncStatus': () => ({ entryCount: 4, tombstoneCount: 0, lastSyncAt: null }),
};

const MOCK_CATALOG_ENTRIES = [
	{
		network_id: 'net-test', lish_id: 'ubuntu-24', name: 'Ubuntu 24.04 LTS',
		description: 'Official Ubuntu Desktop ISO with GNOME',
		publisher_peer_id: 'test-mod-1', published_at: '2026-03-01T10:00:00Z',
		chunk_size: 1048576, checksum_algo: 'sha256',
		total_size: 4_500_000_000, file_count: 1,
		manifest_hash: 'sha256:abc123', content_type: 'software',
		tags: '["linux","ubuntu","desktop"]', last_edited_by: null,
		hlc_wall: 1773000000000,
	},
	{
		network_id: 'net-test', lish_id: 'fedora-41', name: 'Fedora Workstation 41',
		description: 'Fedora with GNOME 47 desktop environment',
		publisher_peer_id: 'test-mod-1', published_at: '2026-03-05T12:00:00Z',
		chunk_size: 1048576, checksum_algo: 'sha256',
		total_size: 3_000_000_000, file_count: 1,
		manifest_hash: 'sha256:def456', content_type: 'software',
		tags: '["linux","fedora"]', last_edited_by: null,
		hlc_wall: 1773100000000,
	},
	{
		network_id: 'net-test', lish_id: 'arch-2026', name: 'Arch Linux 2026.03',
		description: 'Rolling release Linux distribution',
		publisher_peer_id: 'test-mod-2', published_at: '2026-03-10T08:00:00Z',
		chunk_size: 1048576, checksum_algo: 'sha256',
		total_size: 850_000_000, file_count: 1,
		manifest_hash: 'sha256:ghi789', content_type: 'software',
		tags: '["linux","arch"]', last_edited_by: null,
		hlc_wall: 1773200000000,
	},
	{
		network_id: 'net-test', lish_id: 'imagenet', name: 'ImageNet 2026',
		description: 'Machine learning training dataset',
		publisher_peer_id: 'test-mod-2', published_at: '2026-03-12T14:00:00Z',
		chunk_size: 4194304, checksum_algo: 'sha256',
		total_size: 150_000_000_000, file_count: 1281167,
		manifest_hash: 'sha256:jkl012', content_type: 'dataset',
		tags: '["ml","dataset","training"]', last_edited_by: null,
		hlc_wall: 1773300000000,
	},
];

function handleMessage(ws: WebSocket, data: string): void {
	let msg: { id?: number; method?: string; params?: Record<string, unknown> };
	try {
		msg = JSON.parse(data);
	} catch {
		console.error('[MockBackend] Invalid JSON:', data);
		return;
	}

	if (msg.id === undefined || !msg.method) return;

	const handler = handlers[msg.method];
	const result = handler ? handler(msg.params ?? {}) : { success: true };

	ws.send(JSON.stringify({ id: msg.id, result }));
}

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
	console.log('[MockBackend] Client connected');
	ws.on('message', (data) => handleMessage(ws, data.toString()));
	ws.on('close', () => console.log('[MockBackend] Client disconnected'));
});

wss.on('listening', () => {
	console.log(`[MockBackend] Listening on port ${PORT}`);
});

process.on('SIGTERM', () => {
	wss.close();
	process.exit(0);
});

process.on('SIGINT', () => {
	wss.close();
	process.exit(0);
});
