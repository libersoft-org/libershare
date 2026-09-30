import { afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initLISHsTables } from '../../../src/db/lishs.ts';
import { initUploadState, resetUploadState, setUploadRecoveryHooks } from '../../../src/protocol/lish-protocol.ts';
import { initDownloadState } from '../../../src/api/transfer.ts';

const databases = new Set<Database>();

export function createDB(): Database {
	const db = new Database(':memory:');
	databases.add(db);
	db.run('PRAGMA foreign_keys = ON');
	initLISHsTables(db);
	return db;
}

afterEach(() => {
	// Detach persistence callbacks before closing the databases they reference.
	initUploadState(new Set(), () => {});
	initDownloadState(new Set(), () => {});
	resetUploadState();
	setUploadRecoveryHooks(null, null, null);
	for (const db of databases) db.close();
	databases.clear();
});
