import { type Database } from 'bun:sqlite';
import { type LISHNetworkConfig, type LISHNetworkDefinition } from '@shared';

export function initLISHnetsTables(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS lishnets (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			lishnet_id      TEXT NOT NULL UNIQUE,
			name            TEXT NOT NULL,
			description     TEXT,
			enabled         BOOL NOT NULL DEFAULT FALSE,
			created         TIMESTAMP,
			added           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS lishnets_peers (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			id_lishnets     INTEGER NOT NULL REFERENCES lishnets(id) ON DELETE CASCADE,
			address         TEXT NOT NULL
		)
	`);

	db.run('CREATE INDEX IF NOT EXISTS idx_lishnets_peers_id_lishnets ON lishnets_peers(id_lishnets)');
}

// -- Internal helpers --

function getInternalID(db: Database, networkID: string): number | null {
	const row = db.query<{ id: number }, [string]>('SELECT id FROM lishnets WHERE lishnet_id = ?').get(networkID);
	return row?.id ?? null;
}

function getBootstrapPeers(db: Database, internalID: number): string[] {
	return db
		.query<{ address: string }, [number]>('SELECT address FROM lishnets_peers WHERE id_lishnets = ? ORDER BY id')
		.all(internalID)
		.map(r => r.address);
}

interface LISHnetRow {
	id: number;
	lishnet_id: string;
	name: string;
	description: string | null;
	enabled: number;
	created: string | null;
}

function buildConfig(db: Database, row: LISHnetRow): LISHNetworkConfig {
	const peers = getBootstrapPeers(db, row.id);
	return {
		networkID: row.lishnet_id,
		name: row.name,
		description: row.description ?? '',
		bootstrapPeers: peers,
		enabled: row.enabled === 1,
		created: row.created ?? '',
	};
}

// -- Public API --

export function lishnetExists(db: Database, networkID: string): boolean {
	const row = db.query<{ c: number }, [string]>('SELECT COUNT(*) as c FROM lishnets WHERE lishnet_id = ?').get(networkID);
	return (row?.c ?? 0) > 0;
}

export function getLISHnet(db: Database, networkID: string): LISHNetworkConfig | undefined {
	const row = db.query<LISHnetRow, [string]>('SELECT id, lishnet_id, name, description, enabled, created FROM lishnets WHERE lishnet_id = ?').get(networkID);
	if (!row) return undefined;
	return buildConfig(db, row);
}

export function listLISHnets(db: Database): LISHNetworkConfig[] {
	const rows = db.query<LISHnetRow, []>('SELECT id, lishnet_id, name, description, enabled, created FROM lishnets ORDER BY added ASC').all();
	return rows.map(r => buildConfig(db, r));
}

export function listEnabledLISHnets(db: Database): LISHNetworkConfig[] {
	const rows = db.query<LISHnetRow, []>('SELECT id, lishnet_id, name, description, enabled, created FROM lishnets WHERE enabled = TRUE ORDER BY added ASC').all();
	return rows.map(r => buildConfig(db, r));
}

export function addLISHnet(db: Database, network: LISHNetworkConfig): boolean {
	const networkID = network.networkID || crypto.randomUUID();
	if (lishnetExists(db, networkID)) return false;

	const tx = db.transaction(() => {
		const result = db.run(
			`INSERT INTO lishnets (lishnet_id, name, description, enabled, created)
			 VALUES (?, ?, ?, ?, ?)`,
			[networkID, network.name, network.description || null, network.enabled ? 1 : 0, network.created || null]
		);
		const internalID = Number(result.lastInsertRowid);

		for (const peer of network.bootstrapPeers) {
			db.run('INSERT INTO lishnets_peers (id_lishnets, address) VALUES (?, ?)', [internalID, peer]);
		}
	});
	tx();
	return true;
}

export function updateLISHnet(db: Database, network: LISHNetworkConfig): boolean {
	const internalID = getInternalID(db, network.networkID);
	if (internalID === null) return false;

	const tx = db.transaction(() => {
		db.run(
			`UPDATE lishnets SET name = ?, description = ?, enabled = ?, created = ?
			 WHERE id = ?`,
			[network.name, network.description || null, network.enabled ? 1 : 0, network.created || null, internalID]
		);

		// Replace peers
		db.run('DELETE FROM lishnets_peers WHERE id_lishnets = ?', [internalID]);
		for (const peer of network.bootstrapPeers) {
			db.run('INSERT INTO lishnets_peers (id_lishnets, address) VALUES (?, ?)', [internalID, peer]);
		}
	});
	tx();
	return true;
}

export function deleteLISHnet(db: Database, networkID: string): boolean {
	const result = db.run('DELETE FROM lishnets WHERE lishnet_id = ?', [networkID]);
	return result.changes > 0;
}

export function setLISHnetEnabled(db: Database, networkID: string, enabled: boolean): boolean {
	const result = db.run('UPDATE lishnets SET enabled = ? WHERE lishnet_id = ?', [enabled ? 1 : 0, networkID]);
	return result.changes > 0;
}

export function addLISHnetIfNotExists(db: Database, network: LISHNetworkDefinition): boolean {
	if (lishnetExists(db, network.networkID)) return false;
	return addLISHnet(db, { ...network, enabled: false });
}

export function importLISHnets(db: Database, networks: LISHNetworkDefinition[]): number {
	let imported = 0;
	for (const network of networks) {
		if (addLISHnetIfNotExists(db, network)) imported++;
	}
	return imported;
}

/**
 * Upsert a lishnet from an ILISHNetwork import (file or JSON).
 */
export function upsertLISHnet(db: Database, networkID: string, name: string, description: string, bootstrapPeers: string[], enabled: boolean, created: string): void {
	const config: LISHNetworkConfig = { networkID, name, description, bootstrapPeers, enabled, created };
	if (lishnetExists(db, networkID)) {
		updateLISHnet(db, config);
	} else {
		addLISHnet(db, config);
	}
}

/**
 * Replace all lishnets (for reordering). Deletes all existing, re-inserts in order.
 */
export function replaceLISHnets(db: Database, networks: LISHNetworkConfig[]): void {
	const tx = db.transaction(() => {
		db.run('DELETE FROM lishnets');
		for (const network of networks) {
			const result = db.run(
				`INSERT INTO lishnets (lishnet_id, name, description, enabled, created)
				 VALUES (?, ?, ?, ?, ?)`,
				[network.networkID, network.name, network.description || null, network.enabled ? 1 : 0, network.created || null]
			);
			const internalID = Number(result.lastInsertRowid);
			for (const peer of network.bootstrapPeers) {
				db.run('INSERT INTO lishnets_peers (id_lishnets, address) VALUES (?, ?)', [internalID, peer]);
			}
		}
	});
	tx();
}
