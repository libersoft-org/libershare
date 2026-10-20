import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { type LISHNetworkConfig, type LISHOverlayDefinition } from '@shared';
import { initLISHnetsTables, addLISHnet, getLISHnet, listLISHnets, updateLISHnet, upsertLISHnet, replaceLISHnets, addLISHnetIfNotExists, setLISHnetOverlay } from '../../../src/db/lishnets.ts';

const overlay: LISHOverlayDefinition = { type: 'nebula', caCert: '-----BEGIN NEBULA CERTIFICATE V2-----\nAAAA\n-----END NEBULA CERTIFICATE V2-----\n', subnet: '100.64.0.0/16', lighthouses: [{ vpnIP: '100.64.0.1', addr: '203.0.113.7:4242' }], relays: [], lanDirect: false, version: 0 };
const base: LISHNetworkConfig = { networkID: 'p1', name: 'Protected', description: '', bootstrapPeers: [], enabled: false, created: '2026-10-16T08:00:00.000Z' };

function fresh(): Database {
	const db = new Database(':memory:');
	initLISHnetsTables(db);
	return db;
}

describe('lishnets overlay column', () => {
	it('adds the column to a database created before it existed and reads old rows as public', () => {
		const db = new Database(':memory:');
		db.run('CREATE TABLE lishnets (id INTEGER PRIMARY KEY AUTOINCREMENT, lishnet_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT, enabled BOOL NOT NULL DEFAULT FALSE, created TIMESTAMP, added TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)');
		db.run("INSERT INTO lishnets (lishnet_id, name) VALUES ('old', 'Old')");
		initLISHnetsTables(db);
		expect(getLISHnet(db, 'old')?.overlay).toBeUndefined();
		expect(addLISHnet(db, { ...base, overlay })).toBe(true);
		expect(getLISHnet(db, 'p1')?.overlay).toEqual(overlay);
	});

	it('is written by add, add-if-not-exists and upsert', () => {
		const db = fresh();
		addLISHnet(db, { ...base, overlay });
		addLISHnetIfNotExists(db, { ...base, networkID: 'p2', overlay });
		upsertLISHnet(db, 'p3', 'P3', '', [], false, '', overlay);
		for (const id of ['p1', 'p2', 'p3']) expect(getLISHnet(db, id)?.overlay).toEqual(overlay);
	});

	it('survives an update and a reorder that do not mention it', () => {
		const db = fresh();
		addLISHnet(db, { ...base, overlay });
		addLISHnet(db, { ...base, networkID: 'pub', name: 'Public' });
		updateLISHnet(db, { ...base, name: 'Renamed' });
		expect(getLISHnet(db, 'p1')).toMatchObject({ name: 'Renamed', overlay });
		const withoutOverlay = listLISHnets(db).map(({ overlay: _o, ...rest }) => rest);
		replaceLISHnets(db, withoutOverlay.reverse());
		expect(listLISHnets(db).map(n => [n.networkID, n.overlay !== undefined])).toEqual([
			['pub', false],
			['p1', true],
		]);
	});

	it('takes a newer definition from an update or from setLISHnetOverlay', () => {
		const db = fresh();
		addLISHnet(db, { ...base, overlay });
		const v1 = { ...overlay, version: 1, relays: [{ vpnIP: '100.64.0.2', addr: '198.51.100.3:4242' }] };
		updateLISHnet(db, { ...base, overlay: v1 });
		expect(getLISHnet(db, 'p1')?.overlay).toEqual(v1);
		const v2 = { ...v1, version: 2 };
		expect(setLISHnetOverlay(db, 'p1', v2)).toBe(true);
		expect(getLISHnet(db, 'p1')?.overlay?.version).toBe(2);
		expect(setLISHnetOverlay(db, 'missing', v2)).toBe(false);
	});
});
