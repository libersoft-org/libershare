import { afterEach, expect, spyOn, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodedError, ErrorCodes } from '@shared';
import { initDownloadState, initTransferHandlers, removeDownloadState } from '../../../src/api/transfer.ts';
import { initLISHScopes, initUploadState } from '../../../src/protocol/lish-protocol.ts';
import { Downloader } from '../../../src/protocol/downloader.ts';
import type { Networks } from '../../../src/lishnet/lishnets.ts';
import type { DataServer } from '../../../src/lish/data-server.ts';
import type { Settings } from '../../../src/settings.ts';

afterEach(() => initLISHScopes(new Map(), () => {}));

/**
 * A member of two protected lishnets downloaded a LISH shared in the second one on the first one's node, whose
 * peers all answered "not shared", and the download never moved.
 */
for (const [scope, expected] of [
	[['net-b'], 'net-b'],
	[[], 'public'],
] as const)
	test(`a LISH shared in ${scope.length > 0 ? 'a protected lishnet' : 'public'} downloads on the ${expected} node`, async () => {
		const id = `scoped-download-${expected}`;
		initDownloadState(new Set(), () => {});
		initUploadState(new Set(), () => {});
		initLISHScopes(new Map(scope.length > 0 ? [[id, [...scope]]] : []), () => {});
		const nodes = new Map<string, object>(['public', 'net-a', 'net-b'].map(n => [n, { name: n, onPeerDisconnect: () => () => {} }]));
		const networks = {
			get: (n: string) => ({ networkID: n, overlay: n === 'public' ? undefined : {} }),
			networkFor: (n: string) => nodes.get(n),
			protectedNodes: () => [],
			getRunningNetwork: () => nodes.get('public'),
			getEnabled: () => [{ networkID: 'net-a' }, { networkID: 'net-b' }, { networkID: 'public' }],
			isJoined: () => true,
			set onNetworkLeft(_callback: unknown) {},
			set onNetworkJoined(_callback: unknown) {},
		} as unknown as Networks;
		const data = {
			get: () => ({ id, name: 'download', directory: null, files: [] }),
			getDatasetRoot: (): null => null,
			getAllChunkCount: () => 4,
			getMissingChunks: () => ['chunk-0'],
			isCompleteLISH: () => false,
			getTransferStats: () => ({ downloadedBytes: 0, uploadedBytes: 0 }),
			clearError: () => {},
			isVerifyPending: () => false,
			setError: () => {},
		} as unknown as DataServer;
		let cancel!: (error: Error) => void;
		const running = new Promise<void>((_, reject) => {
			cancel = reject;
		});
		void running.catch(() => {});
		let used: { node: unknown; networkIDs: string[] } | undefined;
		const start = spyOn(Downloader.prototype, 'download').mockImplementation(function (this: Downloader) {
			used = { node: (this as any).network, networkIDs: this.getNetworkIDs() };
			return running;
		});
		const handlers = initTransferHandlers(
			networks,
			data,
			tmpdir(),
			() => {},
			() => {},
			{ get: () => false } as unknown as Settings
		);
		try {
			expect(await handlers.enableDownload({ lishID: id })).toEqual({ success: true });
			expect(used?.node).toBe(nodes.get(expected));
			expect(used?.networkIDs).toEqual([expected]);
		} finally {
			cancel(new CodedError(ErrorCodes.DOWNLOAD_CANCELLED));
			await removeDownloadState(id);
			start.mockRestore();
		}
	});

/**
 * A public node and two protected lishnets, all joined, with real transfer handlers; the downloads never touch the
 * network (`download` is stubbed) and each start is recorded with its node and lishnets.
 */
function world(id: string, scope: string[]) {
	initDownloadState(new Set(), () => {});
	initUploadState(new Set(), () => {});
	initLISHScopes(new Map(scope.length > 0 ? [[id, scope]] : []), () => {});
	const joined = new Set(['public', 'net-a', 'net-b']);
	const node = (n: string): object => ({ name: n, lishScope: n === 'public' ? null : n, onPeerDisconnect: () => () => {} });
	const nodes = new Map<string, object>(['public', 'net-a', 'net-b'].map(n => [n, node(n)]));
	let onJoined!: (networkID: string) => void;
	let onLeft!: (networkID: string) => void;
	const networks = {
		get: (n: string) => ({ networkID: n, overlay: n === 'public' ? undefined : {} }),
		networkFor: (n: string) => nodes.get(n),
		protectedNodes: () => [],
		getRunningNetwork: () => nodes.get('public'),
		getEnabled: () => [...joined].map(networkID => ({ networkID })),
		isJoined: (n: string) => joined.has(n),
		set onNetworkLeft(callback: (networkID: string) => void) {
			onLeft = callback;
		},
		set onNetworkJoined(callback: (networkID: string) => void) {
			onJoined = callback;
		},
	} as unknown as Networks;
	const data = {
		get: () => ({ id, name: 'download', directory: null, files: [] }),
		getDatasetRoot: (): null => null,
		getAllChunkCount: () => 4,
		getMissingChunks: () => ['chunk-0'],
		isCompleteLISH: () => false,
		getTransferStats: () => ({ downloadedBytes: 0, uploadedBytes: 0 }),
		clearError: () => {},
		isVerifyPending: () => false,
		setError: () => {},
	} as unknown as DataServer;
	const cancels: Array<(error: Error) => void> = [];
	const used: Array<{ downloader: Downloader; node: unknown }> = [];
	const start = spyOn(Downloader.prototype, 'download').mockImplementation(function (this: Downloader) {
		used.push({ downloader: this, node: (this as any).network });
		const running = new Promise<void>((_, reject) => cancels.push(reject));
		void running.catch(() => {});
		return running;
	});
	const handlers = initTransferHandlers(
		networks,
		data,
		tmpdir(),
		() => {},
		() => {},
		{ get: () => false } as unknown as Settings
	);
	return {
		handlers,
		nodes,
		used,
		replaceNode: (n: string) => nodes.set(n, node(n)),
		leave: (n: string) => {
			joined.delete(n);
			onLeft(n);
		},
		join: (n: string) => {
			joined.add(n);
			onJoined(n);
		},
		started: async (count: number) => {
			for (let i = 0; i < 100 && used.length < count; i++) await Bun.sleep(10);
		},
		cleanup: async () => {
			for (const cancel of cancels) cancel(new CodedError(ErrorCodes.DOWNLOAD_CANCELLED));
			await removeDownloadState(id);
			start.mockRestore();
		},
	};
}

/** A protected lishnet left and joined again came back into a public download, which then asked for the LISH there. */
test('a public download does not take in a protected lishnet joined again', async () => {
	const w = world('public-rejoin', []);
	try {
		expect(await w.handlers.enableDownload({ lishID: 'public-rejoin' })).toEqual({ success: true });
		w.leave('net-a');
		w.join('net-a');
		await Bun.sleep(20);
		expect(w.used[0]!.downloader.getNetworkIDs()).toEqual(['public']);
	} finally {
		await w.cleanup();
	}
});

/** A LISH made protected while it downloaded kept downloading on the public node. */
test('a download moves to its lishnet when its scope changes', async () => {
	const w = world('scope-change', []);
	try {
		expect(await w.handlers.enableDownload({ lishID: 'scope-change' })).toEqual({ success: true });
		expect(w.used[0]!.node).toBe(w.nodes.get('public'));
		initLISHScopes(new Map([['scope-change', ['net-b']]]), () => {});
		await w.handlers.rehomeDownload('scope-change');
		await w.started(2);
		expect(w.used[1]?.node).toBe(w.nodes.get('net-b'));
		expect(w.used[1]?.downloader.getNetworkIDs()).toEqual(['net-b']);
	} finally {
		await w.cleanup();
	}
});

/** A LISH made public while it downloaded on a protected lishnet stayed there: its own list had no public lishnet. */
test('a download moves to the public node when its LISH is made public', async () => {
	const w = world('made-public', ['net-b']);
	try {
		expect(await w.handlers.enableDownload({ lishID: 'made-public' })).toEqual({ success: true });
		expect(w.used[0]!.node).toBe(w.nodes.get('net-b'));
		initLISHScopes(new Map(), () => {});
		await w.handlers.rehomeDownload('made-public');
		await w.started(2);
		expect(w.used[1]?.node).toBe(w.nodes.get('public'));
		expect(w.used[1]?.downloader.getNetworkIDs()).toEqual(['public']);
	} finally {
		await w.cleanup();
	}
});

/** Suspended when lishnet A left, then moved to lishnet B: it kept waiting for A, even though B was joined. */
test('a suspended download moved to another lishnet starts there instead of waiting for the old one', async () => {
	const w = world('moved-while-suspended', ['net-a']);
	try {
		expect(await w.handlers.enableDownload({ lishID: 'moved-while-suspended' })).toEqual({ success: true });
		expect(w.used[0]!.node).toBe(w.nodes.get('net-a'));
		w.leave('net-a');
		initLISHScopes(new Map([['moved-while-suspended', ['net-b']]]), () => {});
		await w.handlers.rehomeDownload('moved-while-suspended');
		await w.started(2);
		expect(w.used[1]?.node).toBe(w.nodes.get('net-b'));
	} finally {
		await w.cleanup();
	}
});

/** `download <lishPath>` names the first enabled lishnet: a public one asked the public lishnet for a protected LISH. */
test('a download of a stored protected LISH runs on its lishnet whatever lishnet the caller names', async () => {
	const w = world('cli-scoped', ['net-b']);
	const lishPath = join(tmpdir(), `cli-scoped-${Date.now()}.lish`);
	await writeFile(lishPath, JSON.stringify({ id: 'cli-scoped', name: 'download', files: [] }));
	try {
		await w.handlers.download({ networkID: 'public', lishPath }, undefined);
		await w.started(1);
		expect(w.used[0]?.node).toBe(w.nodes.get('net-b'));
		expect(w.used[0]?.downloader.getNetworkIDs()).toEqual(['net-b']);
	} finally {
		await rm(lishPath, { force: true });
		await w.cleanup();
	}
});

/** A `download <lishPath>` moved to another lishnet was stopped and never started again: it had no "enabled" flag. */
test('a download started from a .lish file goes on in the lishnet its scope moves to', async () => {
	const w = world('cli-moved', []);
	const lishPath = join(tmpdir(), `cli-moved-${Date.now()}.lish`);
	await writeFile(lishPath, JSON.stringify({ id: 'cli-moved', name: 'download', files: [] }));
	try {
		await w.handlers.download({ networkID: 'public', lishPath }, undefined);
		await w.started(1);
		expect(w.used[0]?.node).toBe(w.nodes.get('public'));
		initLISHScopes(new Map([['cli-moved', ['net-b']]]), () => {});
		await w.handlers.rehomeDownload('cli-moved');
		await w.started(2);
		expect(w.used[1]?.node).toBe(w.nodes.get('net-b'));
	} finally {
		await rm(lishPath, { force: true });
		await w.cleanup();
	}
});

/** Switched off once, started later from a .lish file, then moved: the old switch-off stopped the move for good. */
test('a later start from a .lish file outranks an older switch-off when the download moves', async () => {
	const w = world('cli-after-off', []);
	const lishPath = join(tmpdir(), `cli-after-off-${Date.now()}.lish`);
	await writeFile(lishPath, JSON.stringify({ id: 'cli-after-off', name: 'download', files: [] }));
	try {
		w.handlers.disableDownload({ lishID: 'cli-after-off' });
		await w.handlers.download({ networkID: 'public', lishPath }, undefined);
		await w.started(1);
		initLISHScopes(new Map([['cli-after-off', ['net-b']]]), () => {});
		await w.handlers.rehomeDownload('cli-after-off');
		await w.started(2);
		expect(w.used[1]?.node).toBe(w.nodes.get('net-b'));
	} finally {
		await rm(lishPath, { force: true });
		await w.cleanup();
	}
});

/** The scope moved from lishnet A to B while a start was reading its manifest: the start went on and asked A. */
test('a start under way when the scope moves gives up and runs in the new lishnet', async () => {
	const w = world('moved-while-starting', ['net-a']);
	let rehoming: Promise<void> | undefined;
	const original = Downloader.prototype.initFromManifest;
	// The scope moves (and the move is asked for) while the first start reads its manifest.
	const read = spyOn(Downloader.prototype, 'initFromManifest').mockImplementation(async function (this: Downloader, lish: any) {
		if (!rehoming) {
			initLISHScopes(new Map([['moved-while-starting', ['net-b']]]), () => {});
			rehoming = w.handlers.rehomeDownload('moved-while-starting');
		}
		return original.call(this, lish);
	});
	try {
		await w.handlers.enableDownload({ lishID: 'moved-while-starting' });
		await rehoming;
		await w.started(1);
		expect(w.used.map(u => u.node)).toEqual([w.nodes.get('net-b')]);
	} finally {
		read.mockRestore();
		await w.cleanup();
	}
});

/** A start from a .lish file read its file while the scope moved from A to B: the move saw nothing and it asked A. */
test('a start from a .lish file under way when the scope moves runs in the new lishnet', async () => {
	const w = world('cli-moved-while-starting', ['net-a']);
	const lishPath = join(tmpdir(), `cli-moved-starting-${Date.now()}.lish`);
	await writeFile(lishPath, JSON.stringify({ id: 'cli-moved-while-starting', name: 'download', files: [] }));
	let rehoming: Promise<void> | undefined;
	const original = Downloader.prototype.init;
	// The scope moves (and the move is asked for) while the start reads the file on lishnet A's node.
	const read = spyOn(Downloader.prototype, 'init').mockImplementation(async function (this: Downloader, path: string) {
		const result = await original.call(this, path);
		if (!rehoming && (this as any).network === w.nodes.get('net-a')) {
			initLISHScopes(new Map([['cli-moved-while-starting', ['net-b']]]), () => {});
			rehoming = w.handlers.rehomeDownload('cli-moved-while-starting');
		}
		return result;
	});
	try {
		await w.handlers.download({ networkID: 'public', lishPath }, undefined);
		await rehoming;
		await w.started(1);
		expect(w.used.map(u => u.node)).toEqual([w.nodes.get('net-b')]);
	} finally {
		read.mockRestore();
		await rm(lishPath, { force: true });
		await w.cleanup();
	}
});

/** A protected lishnet joined again runs on a new node; the download held on to the stopped one. */
test("a download follows its protected lishnet's new node", async () => {
	const w = world('new-node', ['net-b']);
	try {
		expect(await w.handlers.enableDownload({ lishID: 'new-node' })).toEqual({ success: true });
		const before = w.nodes.get('net-b');
		expect(w.used[0]!.node).toBe(before);
		w.replaceNode('net-b');
		w.join('net-b');
		await w.started(2);
		expect(w.used[1]?.node).toBe(w.nodes.get('net-b'));
		expect(w.used[1]?.node).not.toBe(before);
	} finally {
		await w.cleanup();
	}
});

/** Its protected lishnet down after a restart, the public one up: the download asked for it on the public node. */
test('a LISH of a protected lishnet that is not joined waits for it instead of downloading elsewhere', async () => {
	const id = 'scoped-download-waiting';
	initDownloadState(new Set(), () => {});
	initUploadState(new Set(), () => {});
	initLISHScopes(new Map([[id, ['net-b']]]), () => {});
	const joined = new Set(['public', 'net-a']);
	const nodes = new Map<string, object>(['public', 'net-a', 'net-b'].map(n => [n, { name: n, onPeerDisconnect: () => () => {} }]));
	let onJoined!: (networkID: string) => void;
	const networks = {
		get: (n: string) => ({ networkID: n, overlay: n === 'public' ? undefined : {} }),
		networkFor: (n: string) => nodes.get(n),
		protectedNodes: () => [],
		getRunningNetwork: () => nodes.get('public'),
		getEnabled: () => [...joined].map(networkID => ({ networkID })),
		isJoined: (n: string) => joined.has(n),
		set onNetworkLeft(_callback: unknown) {},
		set onNetworkJoined(callback: (networkID: string) => void) {
			onJoined = callback;
		},
	} as unknown as Networks;
	const data = {
		get: () => ({ id, name: 'download', directory: null, files: [] }),
		getDatasetRoot: (): null => null,
		getAllChunkCount: () => 4,
		getMissingChunks: () => ['chunk-0'],
		isCompleteLISH: () => false,
		getTransferStats: () => ({ downloadedBytes: 0, uploadedBytes: 0 }),
		clearError: () => {},
		isVerifyPending: () => false,
		setError: () => {},
	} as unknown as DataServer;
	let cancel!: (error: Error) => void;
	const running = new Promise<void>((_, reject) => {
		cancel = reject;
	});
	void running.catch(() => {});
	const used: Array<{ node: unknown; networkIDs: string[] }> = [];
	const start = spyOn(Downloader.prototype, 'download').mockImplementation(function (this: Downloader) {
		used.push({ node: (this as any).network, networkIDs: this.getNetworkIDs() });
		return running;
	});
	const handlers = initTransferHandlers(
		networks,
		data,
		tmpdir(),
		() => {},
		() => {},
		{ get: () => false } as unknown as Settings
	);
	try {
		expect(await handlers.enableDownload({ lishID: id })).toEqual({ success: false });
		expect(used).toEqual([]);
		joined.add('net-b');
		onJoined('net-b');
		for (let i = 0; i < 50 && used.length === 0; i++) await Bun.sleep(10);
		expect(used).toEqual([{ node: nodes.get('net-b'), networkIDs: ['net-b'] }]);
	} finally {
		cancel(new CodedError(ErrorCodes.DOWNLOAD_CANCELLED));
		await removeDownloadState(id);
		start.mockRestore();
	}
});
