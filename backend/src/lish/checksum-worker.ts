// Worker for parallel checksum calculation.
// Self-contained: must NOT import other project modules so it can be embedded
// into the compiled binary via `with { type: 'file' }`.
//
// IMPORTANT: This file is loaded by Bun as a raw asset and parsed at runtime.
// Avoid TS-only syntax (interface, declare, type annotations) — keep it valid JS.

// Listen for messages from main thread
self.onmessage = async function (event) {
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
