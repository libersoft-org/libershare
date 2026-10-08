import { type HashAlgorithm } from '@shared';
// Same self-contained worker as file verification uses; see checksum-worker.js for why it is JS.
// @ts-expect-error - Bun-specific `with { type: 'file' }` import returns the asset path as a string
import checksumWorkerPath from './checksum-worker.js' with { type: 'file' };

/**
 * Calculate a checksum for a file chunk.
 * Shared between single-threaded path (lish.ts) and worker (checksum-worker.ts).
 */
export async function calculateChecksum(file: ReturnType<typeof Bun.file>, offset: number, chunkSize: number, algo: HashAlgorithm): Promise<string> {
	const end = Math.min(offset + chunkSize, file.size);
	const chunk = file.slice(offset, end);
	const buffer = await chunk.arrayBuffer();
	const hasher = new Bun.CryptoHasher(algo as any);
	hasher.update(buffer);
	return hasher.digest('hex');
}

// The SHA-2 checksums WebCrypto computes. Its digest runs off the main thread, so hashing a
// downloaded chunk does not stall the event loop that receives and decrypts the next ones.
const WEB_DIGEST: Partial<Record<HashAlgorithm, string>> = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };

/**
 * Hashes in-memory bytes for the algorithms WebCrypto lacks (SHA-3, BLAKE2, SHA-512/256) on a few
 * workers, so no supported algorithm runs on the main thread. Workers start on first use and
 * are unreferenced while idle. If one dies, hashing falls back to the main thread — also for the
 * jobs already handed to the workers, so a worker failure never fails a chunk.
 */
export class BytesChecksumPool {
	private workers: Worker[] | undefined;
	private failed = false;
	private next = 0;
	private nextID = 1;
	private readonly pending = new Map<number, { data: Uint8Array; algo: HashAlgorithm; resolve(checksum: string): void; reject(error: unknown): void }>();

	private readonly workerPath: string;
	private readonly size: number;

	constructor(workerPath: string = checksumWorkerPath, size: number = Math.max(1, Math.min(4, (navigator.hardwareConcurrency ?? 2) - 1))) {
		this.workerPath = workerPath;
		this.size = size;
	}

	async checksum(data: Uint8Array, algo: HashAlgorithm): Promise<string> {
		if (!this.failed) {
			try {
				this.workers ??= this.start();
			} catch {
				this.fail();
			}
		}
		const workers = this.workers;
		if (!workers) return checksumOnMainThread(data, algo);
		const worker = workers[this.next++ % workers.length]!;
		const index = this.nextID++;
		// A private copy of exactly these bytes for the worker to own. `data.slice()` would not do:
		// on a Buffer it is a view, and transferring its `.buffer` would hash and detach the whole
		// backing store, which may be shared with other buffers.
		const copy = new Uint8Array(data.byteLength);
		copy.set(data);
		const bytes = copy.buffer;
		return new Promise((resolve, reject) => {
			this.pending.set(index, { data, algo, resolve, reject });
			try {
				for (const w of workers) w.ref();
				worker.postMessage({ bytes, algo, index }, [bytes]);
			} catch {
				this.fail();
			}
		});
	}

	/**
	 * Give up on the workers: stop them all — they were referenced for the jobs in flight, and left
	 * running they would keep the process alive with no job left to unreference them — and finish
	 * every job they still held on the main thread.
	 */
	private fail(): void {
		this.failed = true;
		for (const w of this.workers ?? []) {
			try {
				w.terminate();
			} catch {}
		}
		this.workers = undefined;
		const jobs = [...this.pending.values()];
		this.pending.clear();
		for (const job of jobs) settleOnMainThread(job);
	}

	private start(): Worker[] {
		const workers: Worker[] = [];
		try {
			for (let i = 0; i < this.size; i++) {
				const worker = new Worker(this.workerPath);
				workers.push(worker);
				worker.unref();
				worker.onmessage = (event: MessageEvent<{ index: number; checksum?: string; error?: string }>) => {
					const job = this.pending.get(event.data.index);
					if (!job) return;
					this.pending.delete(event.data.index);
					if (this.pending.size === 0) for (const w of this.workers ?? []) w.unref();
					if (event.data.checksum !== undefined) job.resolve(event.data.checksum);
					else settleOnMainThread(job);
				};
				worker.onerror = event => {
					event.preventDefault();
					this.fail();
				};
			}
		} catch (error) {
			// Do not leave the workers that did start behind.
			for (const w of workers) w.terminate();
			throw error;
		}
		return workers;
	}
}

const bytesPool = new BytesChecksumPool();

/** Hash a job the workers could not finish on the main thread; the caller still holds its bytes. */
function settleOnMainThread(job: { data: Uint8Array; algo: HashAlgorithm; resolve(checksum: string): void; reject(error: unknown): void }): void {
	try {
		job.resolve(checksumOnMainThread(job.data, job.algo));
	} catch (error) {
		job.reject(error);
	}
}

function checksumOnMainThread(data: Uint8Array, algo: HashAlgorithm): string {
	const hasher = new Bun.CryptoHasher(algo as any);
	hasher.update(data);
	return hasher.digest('hex');
}

/** Hex checksum of bytes in memory, computed off the main thread for every supported algorithm. */
export async function checksumBytes(data: Uint8Array, algo: HashAlgorithm): Promise<string> {
	const web = WEB_DIGEST[algo];
	if (web) return Buffer.from(await crypto.subtle.digest(web, data as Uint8Array<ArrayBuffer>)).toString('hex');
	return bytesPool.checksum(data, algo);
}
