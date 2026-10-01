import { DataServer } from '../../../src/lish/data-server.ts';
import { ChunkDownloader } from '../../../src/protocol/chunk-downloader.ts';

export type ProbeCommand = 'drain-downloads' | 'hold-second-write' | 'wait-write-held' | 'release-write';
export interface ProbeRequest {
	type: 'transfer-probe';
	id: number;
	command: ProbeCommand;
	lishID?: string | undefined;
}

const runs = new Set<Promise<void>>();
const run = ChunkDownloader.prototype.run;
ChunkDownloader.prototype.run = function (): Promise<void> {
	const pending = run.call(this).finally(() => runs.delete(pending));
	runs.add(pending);
	return pending;
};

interface HeldWrite {
	count: number;
	entered: Promise<void>;
	onEntered: () => void;
	released: Promise<void>;
	release: () => void;
}
const holds = new Map<string, HeldWrite>();
const writeChunk = DataServer.prototype.writeChunk;
DataServer.prototype.writeChunk = async function (...args: Parameters<DataServer['writeChunk']>): Promise<void> {
	const hold = holds.get(args[1].id);
	if (hold && ++hold.count === 2) {
		hold.onEntered();
		await hold.released;
	}
	return writeChunk.apply(this, args);
};

async function handle(request: ProbeRequest): Promise<void> {
	if (request.command === 'drain-downloads') {
		// run() includes the disk write and the subsequent database counters.
		while (runs.size > 0) await Promise.all([...runs]);
		return;
	}
	const id = request.lishID;
	if (!id) throw new Error('LISH ID is required');
	if (request.command === 'hold-second-write') {
		if (holds.has(id)) throw new Error('Write hold already exists');
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		holds.set(id, { count: 0, entered: entered.promise, onEntered: entered.resolve, released: released.promise, release: released.resolve });
		return;
	}
	const hold = holds.get(id);
	if (!hold) throw new Error('Write hold does not exist');
	if (request.command === 'wait-write-held') await hold.entered;
	else if (request.command === 'release-write') {
		hold.release();
		holds.delete(id);
	} else throw new Error('Unknown transfer probe command');
}

process.on('message', (message: unknown) => {
	const request = message as ProbeRequest;
	if (request?.type !== 'transfer-probe') return;
	void handle(request).then(
		() => process.send?.({ type: 'transfer-probe', id: request.id }),
		error => process.send?.({ type: 'transfer-probe', id: request.id, error: String(error) })
	);
});
