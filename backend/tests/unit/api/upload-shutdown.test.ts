import { describe, expect, it, afterAll } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initUploadHandlers } from '../../../src/api/upload.ts';

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function setup(): Promise<{ handlers: ReturnType<typeof initUploadHandlers>; uploadDir: string }> {
	const dataDir = await mkdtemp(join(tmpdir(), 'lish-upload-stop-'));
	dirs.push(dataDir);
	return { handlers: initUploadHandlers(dataDir, { sweepIntervalMs: 0 }), uploadDir: join(dataDir, 'tmp') };
}

describe('upload shutdown drains before it returns', () => {
	it('waits for an operation still reading a finished upload, then leaves no file behind', async () => {
		const { handlers, uploadDir } = await setup();
		const client = {};
		const { uploadID } = await handlers.begin({ name: 'a.lish' }, client);
		await handlers.chunk({ uploadID, data: new Uint8Array(1024) }, client);
		await handlers.end({ uploadID }, client);
		let release!: () => void;
		const gate = new Promise<void>(r => (release = r));
		let readDone = false;
		const reading = handlers.withFile({ uploadID }, client, async () => {
			await gate;
			readDone = true;
		});
		let drained = false;
		const draining = handlers.stopAndDrain().then(() => (drained = true));
		await Bun.sleep(20);
		expect(drained).toBe(false);
		release();
		await reading;
		await draining;
		expect(readDone).toBe(true);
		expect(await readdir(uploadDir)).toEqual([]);
	});

	it('removes an upload a client abandoned half-written, including a null (test) client', async () => {
		const { handlers, uploadDir } = await setup();
		const { uploadID } = await handlers.begin({ name: 'half.lish' }, null);
		await handlers.chunk({ uploadID, data: new Uint8Array(4096) }, null);
		await handlers.stopAndDrain();
		expect(await readdir(uploadDir)).toEqual([]);
	});
});
