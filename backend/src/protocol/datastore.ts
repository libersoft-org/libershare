import { Database } from 'bun:sqlite';
import { BaseDatastore } from 'datastore-core';
import { Key } from 'interface-datastore';
import { join, dirname } from 'path';
import { mkdirSync } from 'fs';

/**
 * SQLite-based datastore for libp2p.
 * Replaces datastore-level to avoid native C++ addon (classic-level)
 * which can't be bundled with `bun build --compile`.
 */
// Workaround: bun creates duplicate interface-datastore copies in node_modules,
// causing TypeScript to see identical Key types (v9.0.2) as incompatible
// due to private field nominal typing. Runtime behavior is unaffected.
const _BaseDatastore: any = BaseDatastore;

export class SqliteDatastore extends _BaseDatastore {
	private db!: Database;
	private readonly dbPath: string;

	private stmtPut!: ReturnType<Database['prepare']>;
	private stmtGet!: ReturnType<Database['prepare']>;
	private stmtHas!: ReturnType<Database['prepare']>;
	private stmtDelete!: ReturnType<Database['prepare']>;
	private stmtAll!: ReturnType<Database['prepare']>;
	private stmtAllPrefix!: ReturnType<Database['prepare']>;
	private stmtAllKeys!: ReturnType<Database['prepare']>;
	private stmtAllKeysPrefix!: ReturnType<Database['prepare']>;

	constructor(path: string) {
		super();
		this.dbPath = path.endsWith('.db') ? path : path + '.db';
	}

	private ensureOpen(): void {
		if (!this.db) throw new Error('Datastore not opened. Call open() first.');
	}

	open(): void {
		mkdirSync(dirname(this.dbPath), { recursive: true });
		this.db = new Database(this.dbPath);
		this.db.run('PRAGMA journal_mode = WAL');
		this.db.run(`
			CREATE TABLE IF NOT EXISTS datastore (
				key TEXT PRIMARY KEY,
				value BLOB NOT NULL
			)
		`);
		this.stmtPut = this.db.prepare('INSERT OR REPLACE INTO datastore (key, value) VALUES (?, ?)');
		this.stmtGet = this.db.prepare('SELECT value FROM datastore WHERE key = ?');
		this.stmtHas = this.db.prepare('SELECT 1 FROM datastore WHERE key = ?');
		this.stmtDelete = this.db.prepare('DELETE FROM datastore WHERE key = ?');
		this.stmtAll = this.db.prepare('SELECT key, value FROM datastore');
		this.stmtAllPrefix = this.db.prepare("SELECT key, value FROM datastore WHERE key LIKE ? ESCAPE '\\'");
		this.stmtAllKeys = this.db.prepare('SELECT key FROM datastore');
		this.stmtAllKeysPrefix = this.db.prepare("SELECT key FROM datastore WHERE key LIKE ? ESCAPE '\\'");
	}

	close(): void {
		this.db.close();
	}

	put(key: Key, val: Uint8Array): Key {
		this.ensureOpen();
		this.stmtPut.run(key.toString(), Buffer.from(val));
		return key;
	}

	get(key: Key): Uint8Array {
		this.ensureOpen();
		const row = this.stmtGet.get(key.toString()) as { value: Buffer } | null;
		if (row == null) {
			const err = new Error(`Key not found: ${key.toString()}`);
			(err as any).code = 'ERR_NOT_FOUND';
			throw err;
		}
		return new Uint8Array(row.value);
	}

	has(key: Key): boolean {
		this.ensureOpen();
		return this.stmtHas.get(key.toString()) != null;
	}

	delete(key: Key): void {
		this.ensureOpen();
		this.stmtDelete.run(key.toString());
	}

	batch() {
		const ops: Array<{ type: 'put'; key: Key; value: Uint8Array } | { type: 'del'; key: Key }> = [];
		return {
			put: (key: Key, value: Uint8Array) => {
				ops.push({ type: 'put', key, value });
			},
			delete: (key: Key) => {
				ops.push({ type: 'del', key });
			},
			commit: () => {
				this.db.transaction(() => {
					for (const op of ops) {
						if (op.type === 'put') {
							this.stmtPut.run(op.key.toString(), Buffer.from(op.value));
						} else {
							this.stmtDelete.run(op.key.toString());
						}
					}
				})();
			},
		};
	}

	private escapeLikePrefix(prefix: string): string {
		return prefix.replace(/[%_]/g, '\\$&') + '%';
	}

	*_all(q: { prefix?: string }) {
		this.ensureOpen();
		const rows = q.prefix
			? this.stmtAllPrefix.all(this.escapeLikePrefix(q.prefix)) as Array<{ key: string; value: Buffer }>
			: this.stmtAll.all() as Array<{ key: string; value: Buffer }>;
		for (const row of rows) {
			yield { key: new Key(row.key), value: new Uint8Array(row.value) };
		}
	}

	*_allKeys(q: { prefix?: string }) {
		this.ensureOpen();
		const rows = q.prefix
			? this.stmtAllKeysPrefix.all(this.escapeLikePrefix(q.prefix)) as Array<{ key: string }>
			: this.stmtAllKeys.all() as Array<{ key: string }>;
		for (const row of rows) {
			yield new Key(row.key);
		}
	}
}
