import { describe, expect, it, afterAll } from 'bun:test';
import { Mutex } from 'async-mutex';
import { readFileSync } from 'fs';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { serialiseImportHandlers } from '../../../src/api/api.ts';
import { ErrorCodes } from '@shared';
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
	const end = source.indexOf('serialiseImportHandlers(this.handlers,', start);
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
		// Every entry at once, so the queue allowance is raised out of the way — what
		// is under test here is which handlers hold the lock, not the admission bound.
		serialiseImportHandlers(table.handlers, new Mutex(), () => true, imports.length);
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

describe('import queue admission', () => {
	/** A promise plus the function that settles it, for holding the parser open. */
	function gate(): { wait: Promise<void>; open: () => void } {
		let open!: () => void;
		const wait = new Promise<void>(resolve => (open = resolve));
		return { wait, open };
	}

	it('refuses a direct import once the queue behind the parser is full', async () => {
		const held = gate();
		let entered = 0;
		const handlers: Record<string, (p: any, client: any) => any> = {
			'lishs.parseFromJSON': async () => {
				entered++;
				await held.wait;
				return entered;
			},
		};
		serialiseImportHandlers(handlers, new Mutex(), () => true, 3);
		const parse = handlers['lishs.parseFromJSON']!;
		const client = {};
		// One running plus two waiting fills the allowance; each of those holds its
		// whole request — for `parseFromJSON` that is the file as a string — alive
		// for as long as it waits.
		const admitted = [parse({}, client), parse({}, client), parse({}, client)];
		await Bun.sleep(20);
		await expect(parse({}, client)).rejects.toThrow(ErrorCodes.IMPORT_BUSY);

		held.open();
		await Promise.all(admitted);
		// And the allowance comes back, rather than being spent for good.
		expect(await parse({}, client)).toBe(4);
	});

	it('does not parse for a client that left while its import queued', async () => {
		const held = gate();
		let parsed = 0;
		const live = new Set<any>();
		const handlers: Record<string, (p: any, client: any) => any> = {
			'lishs.parseFromFile': async () => {
				parsed++;
				return parsed;
			},
			'settings.parseFromJSON': async () => {
				await held.wait;
				return 'slow';
			},
		};
		serialiseImportHandlers(handlers, new Mutex(), client => live.has(client));
		const [staying, leaving] = [{}, {}];
		live.add(staying);
		live.add(leaving);

		const slow = handlers['settings.parseFromJSON']!({}, staying);
		await Bun.sleep(20);
		const queued = handlers['lishs.parseFromFile']!({}, leaving).catch((err: any) => err.code);
		await Bun.sleep(20);
		// The socket goes while its import is still behind the slow one.
		live.delete(leaving);
		held.open();

		expect(await slow).toBe('slow');
		expect(await queued).toBe(ErrorCodes.CLIENT_DISCONNECTED);
		// The expensive half never ran for a caller with nowhere to send the answer.
		expect(parsed).toBe(0);
	});
});
