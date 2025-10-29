// Worker for parallel checksum calculation
import type { HashAlgorithm } from './lish.ts';

declare const self: Worker;

export interface WorkerRequest {
	filePath: string;
	offset: number;
	chunkSize: number;
	algo: HashAlgorithm;
	index: number;
}
export interface WorkerResponse {
	index: number;
	checksum: string;
}

// Listen for messages from main thread
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
	const { filePath, offset, chunkSize, algo, index } = event.data;
	try {
		const file = Bun.file(filePath);
		const end = Math.min(offset + chunkSize, file.size);
		const chunk = file.slice(offset, end);
		const buffer = await chunk.arrayBuffer();
		const hasher = new Bun.CryptoHasher(algo as any);
		hasher.update(buffer);
		const checksum = hasher.digest('hex');
		const response: WorkerResponse = { index, checksum };
		self.postMessage(response);
	} catch (error) {
		self.postMessage({ index, error: String(error) });
	}
};
