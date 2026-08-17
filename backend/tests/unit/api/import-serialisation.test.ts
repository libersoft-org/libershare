import { describe, expect, it, afterAll } from 'bun:test';
import { Mutex } from 'async-mutex';
import { readFileSync } from 'fs';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { serialiseImportHandlers } from '../../../src/api/api.ts';
import { initUploadHandlers } from '../../../src/api/upload.ts';

const tempDirs: string[] = [];

afterAll(async () => {
	for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

/**
 * Every method name in the real dispatch table, read out of the source. The
 * table is built inside the `APIServer` constructor, which wants a database, a
 * network stack and a data server before it will hand one over — and what these
 * tests are about is which names are in the table, not a running server.
 */
function dispatchTableMethods(): string[] {
	const source = readFileSync(join(import.meta.dir, '..', '..', '..', 'src', 'api', 'api.ts'), 'utf-8');
	const start = source.indexOf('this.handlers = {');
	const end = source.indexOf('serialiseImportHandlers(this.handlers, this.importLock);', start);
	expect(start).toBeGreaterThan(0);
	expect(end).toBeGreaterThan(start);
	return [...source.slice(start, end).matchAll(/^\t{3}'([a-zA-Z]+\.[a-zA-Z]+)':/gm)].map(match => match[1]!);
}

/** Handlers that count how many of them were ever running at the same time. */
function overlapTable(methods: string[]): { handlers: Record<string, (p: any, client: any) => any>; body: () => Promise<number>; peak: () => number } {
	let running = 0;
	let peak = 0;
	const body = async (): Promise<number> => {
		running++;
		peak = Math.max(peak, running);
		await Bun.sleep(60);
		running--;
		return peak;
	};
	const handlers: Record<string, (p: any, client: any) => any> = {};
	for (const method of methods) handlers[method] = body;
	return { handlers, body, peak: () => peak };
}

describe('import serialisation', () => {
	it('serialises every import the real dispatch table holds', async () => {
		const methods = dispatchTableMethods();
		// A sanity check on the extraction: a regex that matched nothing would make
		// everything below vacuously true.
		expect(methods.length).toBeGreaterThan(50);
		const imports = methods.filter(method => /\.(parseFrom|importFrom)/.test(method) && !method.endsWith('.parseFromUpload'));
		// The four the opt-in list left off. They parse exactly like their
		// `parseFrom*` neighbours — `lishnets.importFromFile` calls
		// `networks.parseFromFile`, the `lishs.importFrom*` three reach
		// `importLISHFromFile` or `parseLISHFromJSON` — and ran straight past the lock.
		expect(imports).toContain('lishnets.importFromFile');
		expect(imports).toContain('lishs.importFromFile');
		expect(imports).toContain('lishs.importFromJSON');
		expect(imports).toContain('lishs.importFromURL');

		const table = overlapTable(imports);
		serialiseImportHandlers(table.handlers, new Mutex());
		await Promise.all(imports.map(method => table.handlers[method]!({}, {})));
		expect(table.peak()).toBe(1);
	});

	it('leaves the uploaded path to take the lock further down', async () => {
		// Wrapping it here as well would take a non-reentrant mutex twice: once here
		// and once inside `withFile`, where an uploaded import waits while its file
		// stays counted against the upload ceilings. That deadlocks the first import.
		const uploaded = ['settings.parseFromUpload', 'identity.parseFromUpload', 'lishnets.parseFromUpload', 'lishs.parseFromUpload'];
		const table = overlapTable(uploaded);
		const lock = new Mutex();
		serialiseImportHandlers(table.handlers, lock);
		const release = await lock.acquire();
		try {
			// Held elsewhere, and these still run — they never touch it at this level.
			await Promise.all(uploaded.map(method => table.handlers[method]!({}, {})));
		} finally {
			release();
		}
		expect(table.peak()).toBe(uploaded.length);
	});

	it('leaves everything that is not an import alone', async () => {
		const table = overlapTable(['lishs.list', 'settings.get', 'fs.readText', 'upload.chunk']);
		const lock = new Mutex();
		serialiseImportHandlers(table.handlers, lock);
		const release = await lock.acquire();
		try {
			await Promise.all(Object.values(table.handlers).map(handler => handler({}, {})));
		} finally {
			release();
		}
		expect(table.peak()).toBe(4);
	});

	it('runs a direct import and an uploaded one on the same lock', async () => {
		const lock = new Mutex();
		const dataDir = join(tmpdir(), `lish-import-serialisation-${crypto.randomUUID()}`);
		tempDirs.push(dataDir);
		const uploads = initUploadHandlers(dataDir, { sweepIntervalMs: 0 }, lock);
		const client = {};
		const { uploadID } = await uploads.begin({ name: 'shared.lish' }, client);
		await uploads.chunk({ uploadID, data: new Uint8Array(1024) }, client);
		await uploads.end({ uploadID }, client);

		// The uploaded side reaches the lock inside `withFile`, the direct side
		// through the wrapper. They have to be the same lock, or the peak memory the
		// serialisation exists to bound is simply doubled again.
		const table = overlapTable(['lishs.parseFromJSON']);
		serialiseImportHandlers(table.handlers, lock);
		// The uploaded side is handed the bare domain handler, exactly as
		// `parseFromUpload` hands `_lishs.parseFromFile` to `withFile` — the wrapped
		// one would take the lock a second time under the one `withFile` holds.
		await Promise.all([uploads.withFile({ uploadID }, client, table.body), table.handlers['lishs.parseFromJSON']!({}, {})]);
		expect(table.peak()).toBe(1);
		uploads.stop();
	});
});
