import { afterEach, describe, expect, it } from 'bun:test';
import { DataServer } from '../../../src/lish/data-server.ts';
import { handleLISHProtocol, initLISHScopes, initUploadState, isServedOn, resetUploadState, setLISHScope } from '../../../src/protocol/lish-protocol.ts';
import { addLISH, getLISHScopes } from '../../../src/db/lishs.ts';
import { createTestDB, createTestLISH, TEST_CHUNK_IDS, TEST_LISH_ID } from '../helpers/fixtures.ts';
import { decodeLISHResponses, fakeLISHStream } from '../helpers/lish-stream.ts';
import { ErrorCodes } from '@shared';

/**
 * Every node of a backend shares one data server, so a LISH shared inside a protected lishnet must be served by that
 * lishnet's node only — never listed, described or served by the public node, nor by another protected lishnet's.
 */

const allowAll = (): boolean => true;
const PROTECTED = 'protected-net';

function setup(): DataServer {
	const db = createTestDB();
	addLISH(db, createTestLISH({ id: TEST_LISH_ID, directory: 'test-data-dir' }));
	const dataServer = new DataServer(db);
	initUploadState(new Set([TEST_LISH_ID]), () => {});
	initLISHScopes(new Map(), (id, ids) => dataServer.setLISHScope(id as any, ids));
	return dataServer;
}

async function ask(dataServer: DataServer, request: Record<string, unknown>, scope: string | null): Promise<any> {
	const { stream, sent } = fakeLISHStream([request]);
	await handleLISHProtocol(stream as any, dataServer, 'peer-member', 'DIRECT', allowAll, allowAll, undefined, scope);
	return (await decodeLISHResponses(sent))[0];
}

describe('LISH scope', () => {
	afterEach(() => {
		resetUploadState();
		initLISHScopes(new Map(), () => {});
	});

	it('keeps a protected LISH off the public node: listing, manifest and chunks', async () => {
		const dataServer = setup();
		setLISHScope(TEST_LISH_ID, [PROTECTED]);
		expect((await ask(dataServer, { type: 'getLishs' }, null)).lishs).toEqual([]);
		expect((await ask(dataServer, { type: 'getLish', lishID: TEST_LISH_ID }, null)).error).toBe(ErrorCodes.PEER_LISH_NOT_SHARED);
		expect((await ask(dataServer, { type: 'getChunk', lishID: TEST_LISH_ID, chunkID: TEST_CHUNK_IDS[0] }, null)).error).toBe(ErrorCodes.PEER_LISH_NOT_SHARED);
		expect((await ask(dataServer, { type: 'getLishs' }, 'other-protected-net')).lishs).toEqual([]);
	});

	it('serves it on its own lishnet node', async () => {
		const dataServer = setup();
		setLISHScope(TEST_LISH_ID, [PROTECTED]);
		expect((await ask(dataServer, { type: 'getLishs' }, PROTECTED)).lishs.map((l: { id: string }) => l.id)).toEqual([TEST_LISH_ID]);
		expect((await ask(dataServer, { type: 'getLish', lishID: TEST_LISH_ID }, PROTECTED)).manifest?.id).toBe(TEST_LISH_ID);
		// Past the gate: the fixture has no data on disk, so the read itself fails — but not as "not shared".
		expect((await ask(dataServer, { type: 'getChunk', lishID: TEST_LISH_ID, chunkID: TEST_CHUNK_IDS[0] }, PROTECTED)).error).not.toBe(ErrorCodes.PEER_LISH_NOT_SHARED);
	});

	it('keeps a public LISH off the protected nodes', async () => {
		const dataServer = setup();
		expect((await ask(dataServer, { type: 'getLishs' }, null)).lishs.map((l: { id: string }) => l.id)).toEqual([TEST_LISH_ID]);
		expect((await ask(dataServer, { type: 'getLishs' }, PROTECTED)).lishs).toEqual([]);
	});

	it('persists the scope, and a damaged one stays restricted', () => {
		const db = createTestDB();
		addLISH(db, createTestLISH({ id: TEST_LISH_ID, directory: 'test-data-dir' }));
		const dataServer = new DataServer(db);
		dataServer.setLISHScope(TEST_LISH_ID as any, [PROTECTED]);
		expect(getLISHScopes(db).get(TEST_LISH_ID)).toEqual([PROTECTED]);
		db.run('UPDATE lishs SET scope = ? WHERE lish_id = ?', ['not json', TEST_LISH_ID]);
		initLISHScopes(getLISHScopes(db), () => {});
		expect(isServedOn(TEST_LISH_ID, null)).toBe(false);
		dataServer.setLISHScope(TEST_LISH_ID as any, []);
		expect(getLISHScopes(db).has(TEST_LISH_ID)).toBe(false);
	});
});
