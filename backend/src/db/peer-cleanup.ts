import { type Database } from 'bun:sqlite';

/**
 * Peers a left lishnet still has to clean out of the peer store, and the lishnets that
 * protect them.
 *
 * A row (X, P) says one of two things, told apart by the current catalog, never by a flag:
 * while X is ENABLED it protects P — another network still uses it; while X is disabled or gone
 * P is a candidate its leave has to remove. Rows survive a process restart, so a leave that
 * was interrupted — the app closed while it hung up peers — is finished before the next start
 * lets those peers be redialled. Deliberately no foreign key: deleting a lishnet must not
 * delete its unfinished cleanup.
 */
export interface PendingPeerCleanup {
	readonly networkID: string;
	readonly peerID: string;
	/** The catalog operation that wrote the row; a newer write of the same row replaces it. */
	readonly operationID: string;
}

export function initPeerCleanupTable(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS pending_peer_cleanup (
			network_id TEXT NOT NULL,
			peer_id TEXT NOT NULL,
			operation_id TEXT NOT NULL,
			PRIMARY KEY (network_id, peer_id)
		)
	`);
}

/**
 * Record `peerIDs` against `networkID` for one operation. Synchronous, so a caller can put it in
 * the same transaction as the catalog write it belongs to. A row that exists takes the new
 * operation ID; nothing already recorded is dropped.
 */
export function recordPeerCleanup(db: Database, networkID: string, peerIDs: Iterable<string>, operationID: string): void {
	const upsert = db.prepare('INSERT INTO pending_peer_cleanup (network_id, peer_id, operation_id) VALUES (?, ?, ?) ON CONFLICT(network_id, peer_id) DO UPDATE SET operation_id = excluded.operation_id');
	for (const peerID of peerIDs) upsert.run(networkID, peerID, operationID);
}

/** Every recorded row. */
export function listPeerCleanup(db: Database): PendingPeerCleanup[] {
	return db
		.query<{ network_id: string; peer_id: string; operation_id: string }, []>('SELECT network_id, peer_id, operation_id FROM pending_peer_cleanup ORDER BY peer_id, network_id')
		.all()
		.map(row => ({ networkID: row.network_id, peerID: row.peer_id, operationID: row.operation_id }));
}

/**
 * Remove the rows of a peer whose cleanup is done — only those still carrying the operation that
 * was read, so a row a newer operation rewrote in the meantime survives.
 */
export function confirmPeerCleanup(db: Database, rows: readonly PendingPeerCleanup[]): void {
	const remove = db.prepare('DELETE FROM pending_peer_cleanup WHERE network_id = ? AND peer_id = ? AND operation_id = ?');
	db.transaction(() => {
		for (const row of rows) remove.run(row.networkID, row.peerID, row.operationID);
	})();
}
