import {mkdir, open, readdir, access, readFile, writeFile} from 'fs/promises';
import {join, dirname, resolve} from 'path';
import type {IManifest, LishId, ChunkId} from './lish.ts';
import {createManifest, DEFAULT_CHUNK_SIZE, DEFAULT_ALGO} from './lish.ts';
import type {Database} from './database.ts';
import {Utils} from './utils.ts';

export interface MissingChunk {
    fileIndex: number;
    chunkIndex: number;
    chunkId: ChunkId
}

export class DataServer {
    private manifests: Map<LishId, IManifest> = new Map();
    private dataDir: string;
    private dataPath: string;
    private downloadDir: string;
    private db: Database;

    constructor(dataDir: string, db: Database) {
        this.dataDir = dataDir;
        this.dataPath = join(dataDir, 'lish');
        this.downloadDir = join(dataDir, 'downloads');
        this.db = db;
    }

    async init() {
        await this.loadManifests();
    }

    private async loadManifests(): Promise<void> {
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
                    const content = await readFile(filePath, 'utf-8');
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

    async getManifest(lishId: LishId): Promise<IManifest | null> {
        const manifest = this.manifests.get(lishId);
        if (!manifest) {
            console.log(`Manifest not found: ${lishId}`);
            return null;
        }
        return manifest;
    }

    getAllManifests(): IManifest[] {
        return Array.from(this.manifests.values());
    }

    public async getChunk(lishId: LishId, chunkId: ChunkId): Promise<Uint8Array | null> {
        const manifest = this.manifests.get(lishId);
        if (!manifest) {
            console.log(`Manifest not found: ${lishId}`);
            return null;
        }

        if (!manifest.files || manifest.files.length === 0) {
            console.log(`No files in manifest: ${lishId}`);
            return null;
        }

        // Get the dataset to find where the actual data files are
        const dataset = this.db.getDatasetByManifest(lishId);
        if (!dataset) {
            console.log(`Dataset not found for manifest: ${lishId}`);
            return null;
        }

        return this.getChunkFromDataset(dataset, manifest, chunkId);
    }

    private async getChunkFromDataset(dataset: {directory: string}, manifest: IManifest, chunkId: ChunkId): Promise<Uint8Array | null> {
        // Find the chunk by its hash across all files
        for (const file of manifest.files) {
            const chunkIndex = file.checksums.findIndex(c => c === chunkId);

            if (chunkIndex !== -1) {
                // Found the chunk, read it from the data file in the dataset directory
                const dataFilePath = join(dataset.directory, file.path);
                try {
                    const chunkSize = manifest.chunkSize;
                    const offset = chunkIndex * chunkSize;

                    // Read the chunk from file using Bun
                    const fileHandle = Bun.file(dataFilePath);
                    const slice = fileHandle.slice(offset, offset + chunkSize);
                    const arrayBuffer = await slice.arrayBuffer();

                    console.log(`read chunk ${chunkId.slice(0, 8)}... from ${file.path} (index ${chunkIndex})`);
                    return new Uint8Array(arrayBuffer);
                } catch (error) {
                    console.log(`Error reading chunk from ${dataFilePath}:`, error);
                    return null;
                }
            }
        }

        console.warn(`Chunk not found in any file: ${chunkId.slice(0, 8)}...`);
        return null;
    }

    public isChunkDownloaded(lishId: LishId, chunkId: ChunkId): boolean {
        return this.db.isChunkDownloaded(lishId, chunkId);
    }

    public markChunkDownloaded(lishId: LishId, chunkId: ChunkId): void {
        this.db.markChunkDownloaded(lishId, chunkId);
    }

    public async getHaveChunks(manifest: IManifest): Promise<Set<ChunkId> | 'all'> {
        const haveChunks = new Set<ChunkId>();

        if (!manifest.files) {
            return haveChunks;
        }

        let haveAll: boolean = true;
        for (const file of manifest.files) {
            for (const chunkId of file.checksums as ChunkId[]) {
                if (this.db.isChunkDownloaded(manifest.id, chunkId)) {
                    haveChunks.add(chunkId);
                } else {
                    haveAll = false;
                }
            }
        }

        return haveAll ? 'all' : haveChunks;
    }

    // Get all chunks that need to be downloaded
    public getMissingChunks(manifest: IManifest): Array<MissingChunk> {
        if (!manifest.files) {
            return [];
        }

        const missing: Array<MissingChunk> = [];
        for (let fileIndex = 0; fileIndex < manifest.files.length; fileIndex++) {
            const file = manifest.files[fileIndex];
            for (let chunkIndex = 0; chunkIndex < file.checksums.length; chunkIndex++) {
                const chunkId = file.checksums[chunkIndex] as ChunkId;
                if (!this.db.isChunkDownloaded(manifest.id, chunkId)) {
                    missing.push({fileIndex, chunkIndex, chunkId});
                }
            }
        }

        return missing;
    }

    // Write a chunk to the appropriate file at the correct offset
    public async writeChunk(
        downloadDir: string,
        manifest: IManifest,
        fileIndex: number,
        chunkIndex: number,
        data: Uint8Array
    ): Promise<void> {
        if (!manifest.files || fileIndex >= manifest.files.length) {
            throw new Error(`Invalid file index: ${fileIndex}`);
        }

        const file = manifest.files[fileIndex];
        const filePath = join(downloadDir, file.path);
        const offset = chunkIndex * manifest.chunkSize;

        // Open file and write at offset
        const fd = await open(filePath, 'r+');
        await fd.write(data, 0, data.length, offset);
        await fd.close();
    }

    // Import a local file/directory as a dataset
    public async importDataset(
        inputPath: string,

				saveToFile: boolean = false,
				addToSharing: boolean = true,
				name: string | undefined,
				description: string | undefined,
				outputFilePath: string | undefined,

				algo: string = DEFAULT_ALGO,
				chunkSize: number = DEFAULT_CHUNK_SIZE,
				threads: number = 0,

        onProgress?: (info: {type: string; path?: string; current?: number; total?: number}) => void
    ): Promise<IManifest> {

			console.log(`Importing dataset from: ${inputPath}, saveToFile=${saveToFile}, addToSharing=${addToSharing}, name=${name}, description=${description}, outputFilePath=${outputFilePath}`);

        const absolutePath = Utils.expandHome(inputPath);
				outputFilePath = outputFilePath ? Utils.expandHome(outputFilePath) : undefined;

console.log('hmmmmmmmmm');
        // Create manifest
        const manifest = await createManifest(
            absolutePath,
            name,
            chunkSize,
            algo as any,
            threads,
            description,
            onProgress
        );

        const lishId = manifest.id as LishId;

				if (saveToFile) {
					this.saveManifestToFile(manifest, outputFilePath);
				}

				if (addToSharing)
				{

					await this.addManifest(manifest);

					// Create dataset row
					this.db.createDataset(lishId, absolutePath);

					// Mark all chunks as downloaded
					if (manifest.files) {
							for (const file of manifest.files) {
									for (const chunkId of file.checksums as ChunkId[]) {
											this.db.markChunkDownloaded(lishId, chunkId);
									}
							}
					}

					// Mark dataset as complete
					const dataset = this.db.getDatasetByManifest(lishId);
					if (dataset) {
							this.db.markDatasetComplete(dataset.id);
					}

					console.log(`✓ Dataset imported: ${lishId}`);

				}

        return manifest;
    }


		// todo: use database instead.
		public async addManifest(manifest: IManifest): Promise<void> {
        // Ensure lish directory exists
        await mkdir(this.dataPath, {recursive: true});


				const lishId = manifest.id as LishId;

				// Write manifest to dataDir/lish/[uuid].lish
        const manifestPath = join(this.dataPath, `${lishId}.lish`);
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
        console.log(`✓ Manifest written to: ${manifestPath}`);
        // Add to in-memory manifests
        this.manifests.set(lishId, manifest);
		}

		private async saveManifestToFile(manifest: IManifest, outputFilePath: string | undefined): Promise<void> {

					// Ensure output directory exists
					if (!outputFilePath)
						throw new Error('Output file path is required when saveToFile is true');
					const outputDir = dirname(outputFilePath);
					await mkdir(outputDir, {recursive: true});

					// Write manifest to specified output file
					await writeFile(outputFilePath, JSON.stringify(manifest, null, 2));
					console.log(`✓ Manifest written to: ${outputFilePath}`);
		}


}
