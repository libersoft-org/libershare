import { Database as BunDatabase } from 'bun:sqlite';
import { join } from 'path';
import type { LishId, ChunkId } from './lish.ts';

export interface Dataset {
	id: number;
	manifest_id: LishId;
	directory: string;
	complete: boolean;
}

export class Database {
	private db!: BunDatabase;
	private readonly dbPath: string;

	constructor(dataDir: string) {
		this.dbPath = join(dataDir, 'database.db');
	}

	getDb(): BunDatabase {
		return this.db;
	}

	async init(): Promise<void> {
		this.db = new BunDatabase(this.dbPath);
		// Create chunks table
		// todo: add file column.
		this.db.run(`
   CREATE TABLE IF NOT EXISTS chunks (
    lish_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    downloaded INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (lish_id, chunk_id)
   )
  `);

		// Create datasets table
		this.db.run(`
   CREATE TABLE IF NOT EXISTS datasets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    manifest_id TEXT NOT NULL,
    directory TEXT NOT NULL,
    complete INTEGER NOT NULL DEFAULT 0
   )
  `);
		console.log(`✓ Database opened at: ${this.dbPath}`);
	}

	// Chunk operations
	isChunkDownloaded(lishId: LishId, chunkId: ChunkId): boolean {
		const stmt = this.db.query('SELECT downloaded FROM chunks WHERE lish_id = ? AND chunk_id = ?');
		const row = stmt.get(lishId, chunkId) as { downloaded: number } | null;
		return row?.downloaded === 1;
	}

	markChunkDownloaded(lishId: LishId, chunkId: ChunkId): void {
		const stmt = this.db.query(`
   INSERT INTO chunks (lish_id, chunk_id, downloaded)
   VALUES (?, ?, 1)
   ON CONFLICT(lish_id, chunk_id) DO UPDATE SET downloaded = 1
  `);
		stmt.run(lishId, chunkId);
	}

	// Dataset operations
	createDataset(manifestId: LishId, directory: string): number {
		const stmt = this.db.query(`
   INSERT INTO datasets (manifest_id, directory, complete)
   VALUES (?, ?, 0)
  `);
		const result = stmt.run(manifestId, directory);
		return Number(result.lastInsertRowid);
	}

	getDataset(id: number): Dataset | null {
		const stmt = this.db.query('SELECT * FROM datasets WHERE id = ?');
		const row = stmt.get(id) as { id: number; manifest_id: string; directory: string; complete: number } | null;
		if (!row) return null;
		return {
			id: row.id,
			manifest_id: row.manifest_id as LishId,
			directory: row.directory,
			complete: row.complete === 1,
		};
	}

	getDatasetByManifest(manifestId: LishId): Dataset | null {
		const stmt = this.db.query('SELECT * FROM datasets WHERE manifest_id = ? ORDER BY complete DESC');
		const row = stmt.get(manifestId) as { id: number; manifest_id: string; directory: string; complete: number } | null;
		if (!row) return null;
		return {
			id: row.id,
			manifest_id: row.manifest_id as LishId,
			directory: row.directory,
			complete: row.complete === 1,
		};
	}

	getAllDatasets(): Dataset[] {
		const stmt = this.db.query('SELECT * FROM datasets');
		const rows = stmt.all() as { id: number; manifest_id: string; directory: string; complete: number }[];
		return rows.map(row => ({
			id: row.id,
			manifest_id: row.manifest_id as LishId,
			directory: row.directory,
			complete: row.complete === 1,
		}));
	}

	markDatasetComplete(id: number): void {
		const stmt = this.db.query('UPDATE datasets SET complete = 1 WHERE id = ?');
		stmt.run(id);
	}

	deleteDataset(id: number): void {
		const stmt = this.db.query('DELETE FROM datasets WHERE id = ?');
		stmt.run(id);
	}

	close(): void {
		if (this.db) {
			this.db.close();
			console.log('Database closed');
		}
	}
}
