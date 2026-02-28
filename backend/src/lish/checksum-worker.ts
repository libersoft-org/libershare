// Worker for parallel checksum calculation
import { type HashAlgorithm } from '@shared';
import { calculateChecksum } from './checksum.ts';

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
self.onmessage = async function (event: MessageEvent<WorkerRequest>) {
	const { filePath, offset, chunkSize, algo, index } = event.data;
	try {
		const file = Bun.file(filePath);
		const checksum = await calculateChecksum(file, offset, chunkSize, algo);
		const response: WorkerResponse = { index, checksum };
		self.postMessage(response);
	} catch (error) {
		self.postMessage({ index, error: String(error) });
	}
};
