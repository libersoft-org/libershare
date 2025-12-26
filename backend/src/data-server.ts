import { readdir, access } from 'fs/promises';
import { join } from 'path';
import { readFileSync } from 'fs';
import type { IManifest, LishId, ChunkId } from './lish.ts';

export interface GetChunkRequest {
	lishId: LishId;
	chunkId: ChunkId;
}

export interface GetChunkResponse {
	data: Uint8Array;
}

export class DataServer {
	private manifests: Map<LishId, IManifest> = new Map();
	private dataDir: string;
	private dataPath: string;

	constructor(dataDir: string) {
		this.dataDir = dataDir;
		this.dataPath = join(dataDir, 'data');
	}

	async init() {
		try {
			// Check if data directory exists
			try {
				await access(this.dataPath);
			} catch {
				console.log(`Data directory does not exist: ${this.dataPath}, skipping manifest loading`);
				return;
			}

			const files = await readdir(this.dataPath);
			const lishFiles = files.filter(f => f.endsWith('.lish'));

			console.log(`Found ${lishFiles.length} .lish files`);

			for (const file of lishFiles) {
				try {
					const filePath = join(this.dataPath, file);
					const content = readFileSync(filePath, 'utf-8');
					const manifest: IManifest = JSON.parse(content);

					if (manifest.id) {
						this.manifests.set(manifest.id as LishId, manifest);
						console.log(`  Loaded: ${filePath} (id: ${manifest.id})`);
					} else {
						console.log(`  Skipped: ${filePath} (no id field)`);
					}
				} catch (error) {
					console.log(`  Error loading ${file}:`, error);
				}
			}

			console.log(`✓ DataServer initialized with ${this.manifests.size} manifests`);
		} catch (error) {
			console.log('Error reading data directory:', error);
		}
	}

	async getChunk(lishId: LishId, chunkId: ChunkId): Promise<Uint8Array | null> {
		const manifest = this.manifests.get(lishId);
		if (!manifest) {
			console.log(`Manifest not found: ${lishId}`);
			return null;
		}

		if (!manifest.files || manifest.files.length === 0) {
			console.log(`No files in manifest: ${lishId}`);
			return null;
		}

		// Find the chunk by its hash across all files
		for (const file of manifest.files) {
			const chunkIndex = file.checksums.findIndex(c => c === chunkId);

			if (chunkIndex !== -1) {
				// Found the chunk, read it from the data file
				const dataFilePath = join(this.dataPath, file.path);
				try {
					const chunkSize = manifest.chunkSize;
					const offset = chunkIndex * chunkSize;

					// Read the chunk from file using Bun
					const fileHandle = Bun.file(dataFilePath);
					const slice = fileHandle.slice(offset, offset + chunkSize);
					const arrayBuffer = await slice.arrayBuffer();

					console.log(`Served chunk ${chunkId.slice(0, 8)}... from ${file.path} (index ${chunkIndex})`);
					return new Uint8Array(arrayBuffer);
				} catch (error) {
					console.log(`Error reading chunk from ${dataFilePath}:`, error);
					return null;
				}
			} else {
				console.warn(`Chunk not found: ${file.path}: ${chunkId}`);
			}
		}

		console.log(`Chunk not found: ${chunkId}`);
		return null;
	}
}
