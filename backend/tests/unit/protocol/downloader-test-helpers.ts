import type { Downloader } from '../../../src/protocol/downloader.ts';
import type { IStoredLISH, LISHid, ChunkID } from '@shared';
import type { MissingChunk } from '../../../src/lish/data-server.ts';
import type { ChunkSlot } from '../../../src/db/lishs-chunks.ts';
import type { FileVerificationProgress } from '../../../src/db/lishs-verification.ts';
type ChunkResult = Uint8Array | null | Error;
type ManifestResult = IStoredLISH | null;

export interface ChunkVerifyResult {
	valid: boolean;
	actualHash: string;
}

export class MockLISHClient {
	requestChunkResult: ChunkResult = new Uint8Array(1024).fill(0xff);
	requestManifestResult: ManifestResult = null;
	requestManifestError: Error | null = null;
	requestManifestCalls = 0;
	closeCalled = false;
	haveChunks: 'all' | ChunkID[] = 'all';
	requestChunkCalls = 0;
	chunkData: Map<ChunkID, Uint8Array> | null = null; // if set, serve per-chunkID (multi-chunk tests)

	async requestChunk(_lishID: LISHid, chunkID: ChunkID): Promise<Uint8Array | null> {
		this.requestChunkCalls++;
		if (this.chunkData) return this.chunkData.get(chunkID) ?? null;
		if (this.requestChunkResult instanceof Error) throw this.requestChunkResult;
		return this.requestChunkResult;
	}

	async requestManifest(_lishID: LISHid): Promise<IStoredLISH | null> {
		this.requestManifestCalls++;
		if (this.requestManifestError) throw this.requestManifestError;
		return this.requestManifestResult;
	}

	async close(): Promise<void> {
		this.closeCalled = true;
	}

	/** Immediate teardown — records the same flag; tests assert the client was released. */
	abort(): void {
		this.closeCalled = true;
	}
}

// ---------------------------------------------------------------------------
// Minimal DataServer mock
// ---------------------------------------------------------------------------

export class MockDataServer {
	missingChunks: MissingChunk[] = [];
	allChunkCount = 0;
	downloadedChunks: Set<ChunkID> = new Set<ChunkID>();
	writtenChunks: Array<{ fileIndex: number; chunkIndex: number; data: Uint8Array }> = [];
	addedLishs: IStoredLISH[] = [];
	storedLishs: Map<string, IStoredLISH> = new Map<string, IStoredLISH>();
	completeLishs: Set<string> = new Set<string>();

	getMissingChunks(_lishID: LISHid): MissingChunk[] {
		return [...this.missingChunks];
	}

	getAllChunkCount(_lishID: LISHid): number {
		return this.allChunkCount;
	}

	// One slot per missing chunk — enough for run()'s duplicate-checksum grouping in tests.
	getAllChunkSlots(_lishID: LISHid): ChunkSlot[] {
		return this.missingChunks.map(c => ({ fileIndex: c.fileIndex, chunkIndex: c.chunkIndex, checksum: c.chunkID }));
	}

	getFileVerificationProgress(_lishID: LISHid): FileVerificationProgress[] {
		return [];
	}

	isChunkDownloaded(_lishID: LISHid, chunkID: ChunkID): boolean {
		return this.downloadedChunks.has(chunkID);
	}

	markChunkDownloaded(_lishID: LISHid, chunkID: ChunkID): void {
		this.downloadedChunks.add(chunkID);
		// Remove from missingChunks to mimic real DB behaviour
		this.missingChunks = this.missingChunks.filter(c => c.chunkID !== chunkID);
	}

	writeChunkError: Error | null = null;
	writeChunkErrorCount = 0; // how many more times to throw before succeeding
	writeChunkOutcomes: Array<Error | null> | null = null; // per-call script (shift); null entry = success
	async writeChunk(_dir: string, _lish: IStoredLISH, fileIndex: number, chunkIndex: number, data: Uint8Array): Promise<void> {
		if (this.writeChunkOutcomes) {
			const outcome = this.writeChunkOutcomes.shift() ?? null;
			if (outcome) throw outcome;
			this.writtenChunks.push({ fileIndex, chunkIndex, data });
			return;
		}
		if (this.writeChunkError && this.writeChunkErrorCount > 0) {
			this.writeChunkErrorCount--;
			throw this.writeChunkError;
		}
		this.writtenChunks.push({ fileIndex, chunkIndex, data });
	}

	incrementDownloadedBytes(_lishID: LISHid, _bytes: number): void {
		/* no-op for tests */
	}

	resetFileChunks(_lishID: LISHid, fileIndex: number): number {
		// Re-add all chunks for this fileIndex to missingChunks
		const lish = [...this.storedLishs.values()][0];
		if (!lish?.files?.[fileIndex]) return 0;
		const file = lish.files[fileIndex]!;
		let resetCount = 0;
		for (let i = 0; i < file.checksums.length; i++) {
			const chunkID = file.checksums[i]! as ChunkID;
			if (this.downloadedChunks.has(chunkID)) {
				this.downloadedChunks.delete(chunkID);
				this.missingChunks.push({ chunkID, fileIndex, chunkIndex: i });
				resetCount++;
			}
		}
		return resetCount;
	}

	add(lish: IStoredLISH): void {
		this.addedLishs.push(lish);
		this.storedLishs.set(lish.id, lish);
	}

	get(lishID: LISHid): IStoredLISH | null {
		return this.storedLishs.get(lishID) ?? null;
	}

	isCompleteLISH(lish: IStoredLISH): boolean {
		return this.completeLishs.has(lish.id);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function makeLISH(overrides: Partial<IStoredLISH> = {}): IStoredLISH {
	return {
		id: 'test-lish-id-0001' as LISHid,
		name: 'Test LISH',
		created: new Date().toISOString(),
		chunkSize: 1024 * 1024,
		checksumAlgo: 'sha256',
		files: [{ path: 'file.bin', size: 1024, checksums: ['abc123'] }],
		directory: '/tmp/test-download',
		...overrides,
	};
}

export function makeMissingChunk(chunkID: ChunkID, fileIndex = 0, chunkIndex = 0): MissingChunk {
	return { chunkID, fileIndex, chunkIndex };
}

/** Access private members for test assertions. */
export function priv(d: Downloader): Record<string, unknown> {
	return d as unknown as Record<string, unknown>;
}
