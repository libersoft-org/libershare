// Worker for parallel checksum calculation.
//
// IMPORTANT — why this file is .js and NOT .ts:
// This worker is imported via `import path from './checksum-worker.js' with { type: 'file' }`
// in lish.ts. That is an *asset* import — Bun copies the file 1:1 into the compiled
// binary's bunfs without transpilation. At runtime `new Worker(path)` parses it as plain
// JavaScript, so any TypeScript-only syntax (interface, type annotations, `declare`,
// `as`, generics, etc.) would crash with `SyntaxError`. Keep this file as valid JS;
// use JSDoc for types if needed.
//
// Self-contained: must NOT import other project modules — the asset import does not
// resolve imports inside the file.

/**
 * @typedef {Object} WorkerRequest
 * @property {string} filePath
 * @property {number} offset
 * @property {number} chunkSize
 * @property {string} algo
 * @property {number} index
 */

/**
 * @typedef {Object} WorkerResponse
 * @property {number} index
 * @property {string} [checksum]
 * @property {string} [error]
 */

/**
 * @typedef {Object} BytesRequest
 * @property {ArrayBuffer} bytes - bytes to hash, transferred to this worker
 * @property {string} algo
 * @property {number} index
 */

// Listen for messages from main thread
self.onmessage = async function (/** @type {MessageEvent<WorkerRequest | BytesRequest>} */ event) {
	if (event.data.bytes) {
		// Bytes already in memory (a downloaded chunk): hash them here, off the main thread.
		const { bytes, algo, index } = event.data;
		try {
			const hasher = new Bun.CryptoHasher(algo);
			hasher.update(bytes);
			self.postMessage({ index, checksum: hasher.digest('hex') });
		} catch (error) {
			self.postMessage({ index, error: String(error) });
		}
		return;
	}
	const { filePath, offset, chunkSize, algo, index } = event.data;
	try {
		const file = Bun.file(filePath);
		const end = Math.min(offset + chunkSize, file.size);
		const chunk = file.slice(offset, end);
		const buffer = await chunk.arrayBuffer();
		const hasher = new Bun.CryptoHasher(algo);
		hasher.update(buffer);
		self.postMessage({ index, checksum: hasher.digest('hex') });
	} catch (error) {
		self.postMessage({ index, error: String(error) });
	}
};
