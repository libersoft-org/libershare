// Worker for parallel checksum calculation.
// Self-contained: must NOT import other project modules so it can be embedded
// into the compiled binary via `with { type: 'file' }`.

declare const self: Worker;

export interface WorkerRequest {
	filePath: string;
	offset: number;
	chunkSize: number;
	algo: string;
	index: number;
}
export interface WorkerResponse {
	index: number;
	checksum: string;
}

// Listen for messages from main thread
self.onmessage = async function (event: MessageEvent<WorkerRequest>) {
	const { filePath, offset, chunkSize, algo, index } = event.data;
	try {
		const file = Bun.file(filePath);
		const end = Math.min(offset + chunkSize, file.size);
		const chunk = file.slice(offset, end);
		const buffer = await chunk.arrayBuffer();
		const hasher = new Bun.CryptoHasher(algo as any);
		hasher.update(buffer);
		const response: WorkerResponse = { index, checksum: hasher.digest('hex') };
		self.postMessage(response);
	} catch (error) {
		self.postMessage({ index, error: String(error) });
	}
};
