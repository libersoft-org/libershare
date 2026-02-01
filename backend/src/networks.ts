import { Database as BunDatabase } from 'bun:sqlite';
import { type ILISHNetwork } from './makenet.ts';
import { Network } from './network.ts';
import { type DataServer } from './data-server.ts';
import { type NetworkDefinition } from '@libershare/shared';

export { type NetworkDefinition };

export class Networks {
	private db: BunDatabase;
	private dataDir: string;
	private dataServer: DataServer;
	private enablePink: boolean;
	private liveNetworks: Map<string, Network> = new Map();

	constructor(db: BunDatabase, dataDir: string, dataServer: DataServer, enablePink: boolean = false) {
		this.db = db;
		this.dataDir = dataDir;
		this.dataServer = dataServer;
		this.enablePink = enablePink;
	}

	init(): void {
		this.db.run(`
			CREATE TABLE IF NOT EXISTS networks (
				id TEXT PRIMARY KEY,
				version INTEGER NOT NULL,
				key TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT,
				bootstrap_peers TEXT NOT NULL,
				enabled INTEGER NOT NULL DEFAULT 0
			)
		`);
		console.log('✓ Networks table initialized');
	}

	async startEnabledNetworks(): Promise<void> {
		const enabled = this.getEnabled();
		for (const def of enabled) {
			await this.startNetwork(def.id);
		}
	}

	async startNetwork(id: string): Promise<Network | null> {
		if (this.liveNetworks.has(id)) {
			console.log(`Network ${id} is already running`);
			return this.liveNetworks.get(id)!;
		}

		const def = this.get(id);
		if (!def) {
			console.log(`Network ${id} not found`);
			return null;
		}

		const network = new Network(this.dataDir, this.dataServer, this.enablePink, def);
		await network.start();
		this.liveNetworks.set(id, network);
		console.log(`✓ Started network: ${def.name} (${id})`);
		return network;
	}

	async stopNetwork(id: string): Promise<void> {
		const network = this.liveNetworks.get(id);
		if (network) {
			await network.stop();
			this.liveNetworks.delete(id);
			console.log(`✓ Stopped network: ${id}`);
		}
	}

	async stopAllNetworks(): Promise<void> {
		for (const [id, network] of this.liveNetworks) {
			await network.stop();
			console.log(`✓ Stopped network: ${id}`);
		}
		this.liveNetworks.clear();
	}

	getLiveNetwork(id: string): Network | undefined {
		return this.liveNetworks.get(id);
	}

	getLiveNetworks(): Map<string, Network> {
		return this.liveNetworks;
	}

	importFromLishnet(data: ILISHNetwork, enabled: boolean = false): NetworkDefinition {
		const network: NetworkDefinition = {
			id: data.networkID,
			version: data.version,
			key: data.swarmKey,
			name: data.name,
			description: data.description || null,
			bootstrap_peers: data.bootstrapPeers,
			enabled,
		};

		const stmt = this.db.query(`
			INSERT INTO networks (id, version, key, name, description, bootstrap_peers, enabled)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				version = excluded.version,
				key = excluded.key,
				name = excluded.name,
				description = excluded.description,
				bootstrap_peers = excluded.bootstrap_peers,
				enabled = excluded.enabled
		`);
		stmt.run(network.id, network.version, network.key, network.name, network.description, JSON.stringify(network.bootstrap_peers), network.enabled ? 1 : 0);

		return network;
	}

	async importFromJson(jsonString: string, enabled: boolean = false): Promise<NetworkDefinition> {
		const data: ILISHNetwork = JSON.parse(jsonString);
		const def = this.importFromLishnet(data, enabled);
		if (enabled) {
			await this.startNetwork(def.id);
		}
		return def;
	}

	async importFromFile(filePath: string, enabled: boolean = false): Promise<NetworkDefinition> {
		const file = Bun.file(filePath);
		const content = await file.text();
		return this.importFromJson(content, enabled);
	}

	async setEnabled(id: string, enabled: boolean): Promise<boolean> {
		const stmt = this.db.query('UPDATE networks SET enabled = ? WHERE id = ?');
		const result = stmt.run(enabled ? 1 : 0, id);
		if (result.changes > 0) {
			if (enabled) {
				await this.startNetwork(id);
			} else {
				await this.stopNetwork(id);
			}
			return true;
		}
		return false;
	}

	get(id: string): NetworkDefinition | null {
		const stmt = this.db.query('SELECT * FROM networks WHERE id = ?');
		const row = stmt.get(id) as {
			id: string;
			version: number;
			key: string;
			name: string;
			description: string | null;
			bootstrap_peers: string;
			enabled: number;
		} | null;

		if (!row) return null;

		return {
			id: row.id,
			version: row.version,
			key: row.key,
			name: row.name,
			description: row.description,
			bootstrap_peers: JSON.parse(row.bootstrap_peers),
			enabled: row.enabled === 1,
		};
	}

	getAll(): NetworkDefinition[] {
		const stmt = this.db.query('SELECT * FROM networks');
		const rows = stmt.all() as {
			id: string;
			version: number;
			key: string;
			name: string;
			description: string | null;
			bootstrap_peers: string;
			enabled: number;
		}[];

		return rows.map(row => ({
			id: row.id,
			version: row.version,
			key: row.key,
			name: row.name,
			description: row.description,
			bootstrap_peers: JSON.parse(row.bootstrap_peers),
			enabled: row.enabled === 1,
		}));
	}

	getEnabled(): NetworkDefinition[] {
		const stmt = this.db.query('SELECT * FROM networks WHERE enabled = 1');
		const rows = stmt.all() as {
			id: string;
			version: number;
			key: string;
			name: string;
			description: string | null;
			bootstrap_peers: string;
			enabled: number;
		}[];

		return rows.map(row => ({
			id: row.id,
			version: row.version,
			key: row.key,
			name: row.name,
			description: row.description,
			bootstrap_peers: JSON.parse(row.bootstrap_peers),
			enabled: true,
		}));
	}

	async delete(id: string): Promise<boolean> {
		await this.setEnabled(id, false);
		const stmt = this.db.query('DELETE FROM networks WHERE id = ?');
		const result = stmt.run(id);
		return result.changes > 0;
	}

	exists(id: string): boolean {
		const stmt = this.db.query('SELECT 1 FROM networks WHERE id = ?');
		return stmt.get(id) !== null;
	}
}
