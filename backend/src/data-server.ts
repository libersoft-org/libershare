import {Database} from 'bun:sqlite';
import {mkdir, open, readdir, access, readFile} from 'fs/promises';
import {join, dirname} from 'path';
import {existsSync} from 'fs';
import type {IManifest, LishId, ChunkId} from './lish.ts';

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
    private db!: Database;

    constructor(dataDir: string) {
        this.dataDir = dataDir;
        this.dataPath = join(dataDir, 'data');
        this.downloadDir = join(dataDir, 'downloads');
    }

    async init() {
        await this.loadManifests();
        await this.initChunksDb();
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


    private async initChunksDb(): Promise<void> {

        // Initialize SQLite database for chunk tracking in dataDir
        const dbPath = join(this.dataDir, 'chunks.db');
        this.db = new Database(dbPath);

        // Create chunks table
        this.db.run(`
            CREATE TABLE IF NOT EXISTS chunks
            (
                lish_id
                    TEXT
                    NOT
                        NULL,
                chunk_id
                    TEXT
                    NOT
                        NULL,
                downloaded
                    INTEGER
                    NOT
                        NULL
                    DEFAULT
                        0,
                PRIMARY
                    KEY
                    (
                     lish_id,
                     chunk_id
                    )
            )
        `);

        console.log(`✓ Chunk tracking database opened at: ${dbPath}`);
    }


    async getManifest(lishId: LishId): Promise<IManifest | null> {
        const manifest = this.manifests.get(lishId);
        if (!manifest) {
            console.log(`Manifest not found: ${lishId}`);
            return null;
        }
        return manifest;
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
            }
        }

        console.warn(`Chunk not found in any file: ${chunkId.slice(0, 8)}...`);
        return null;
    }

    public isChunkDownloaded(
        lishId: LishId,
        chunkId: ChunkId): boolean {
        const stmt = this.db.query('SELECT downloaded FROM chunks WHERE lish_id = ? AND chunk_id = ?');
        const row = stmt.get(lishId, chunkId) as { downloaded: number } | null;
        return row?.downloaded === 1;
    }


    // Mark a chunk as downloaded
    public markChunkDownloaded(
        lishId: LishId,
        chunkId: ChunkId): void {
        const stmt = this.db.query(`
            INSERT INTO chunks (lish_id, chunk_id, downloaded)
            VALUES (?, ?, 1) ON CONFLICT(lish_id, chunk_id)
			DO
            UPDATE SET downloaded = 1
        `);
        stmt.run(lishId, chunkId);
    }


    // Get all chunks that need to be downloaded
    public getMissingChunks(manifest: IManifest): Array<MissingChunk> {
        const missing: Array<{ fileIndex: number; chunkIndex: number; chunkId: ChunkId }> = [];

        if (!manifest.files) {
            return missing;
        }

        for (let fileIndex = 0; fileIndex < manifest.files.length; fileIndex++) {
            const file = manifest.files[fileIndex];
            for (let chunkIndex = 0; chunkIndex < file.checksums.length; chunkIndex++) {
                const chunkId = file.checksums[chunkIndex] as ChunkId;
                if (!this.isChunkDownloaded(manifest.id, chunkId)) {
                    missing.push({fileIndex, chunkIndex, chunkId});
                }
            }
        }

        return missing;
    }


    // Write a chunk to the appropriate file at the correct offset
    public async writeChunk(
        manifest: IManifest,
        fileIndex: number, chunkIndex: number, data: Uint8Array): Promise<void> {
        if (!manifest.files || fileIndex >= manifest.files.length) {
            throw new Error(`Invalid file index: ${fileIndex}`);
        }

        const file = manifest.files[fileIndex];
        const filePath = join(this.downloadDir, file.path);
        const offset = chunkIndex * manifest.chunkSize;

        // Open file and write at offset
        const fd = await open(filePath, 'r+');
        await fd.write(data, 0, data.length, offset);
        await fd.close();
    }


    close(): void {
        if (this.db) {
            this.db.close();
            console.log('Chunk tracking database closed');
        }
    }

}
