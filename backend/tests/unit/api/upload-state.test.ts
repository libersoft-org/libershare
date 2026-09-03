import { describe, expect, it, afterAll, beforeAll } from 'bun:test';
import { readdir, rm, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { type UploadLimits, initUploadHandlers } from '../../../src/api/upload.ts';
import { ErrorCodes } from '@shared';

const tempDirs: string[] = [];

afterAll(async () => {
	for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});
/** Deterministic bytes whose value depends on position. */
function pattern(size: number, seed = 1): Uint8Array {
	const out = new Uint8Array(size);
	for (let i = 0; i < size; i++) out[i] = (i * 31 + seed * 7) & 0xff;
	return out;
}

describe('upload state machine exits', () => {
	type Sink = ReturnType<ReturnType<typeof Bun.file>['writer']>;

	const realBunFile = Bun.file;
	/** Applied to the next writer opened, then cleared. */
	let nextSink: ((sink: Sink) => Sink) | null = null;

	beforeAll(() => {
		(Bun as any).file = (...args: any[]): any => {
			const file = (realBunFile as any)(...args);
			return new Proxy(file, {
				get(target, prop) {
					if (prop === 'writer' && nextSink) {
						const wrap = nextSink;
						nextSink = null;
						return (): Sink => wrap((target as any).writer());
					}
					const value = Reflect.get(target, prop, target);
					return typeof value === 'function' ? value.bind(target) : value;
				},
			});
		};
	});

	afterAll(() => {
		(Bun as any).file = realBunFile;
	});

	/** The real sink with some of its methods replaced. */
	function wrapSink(sink: Sink, overrides: Partial<Sink>): Sink {
		return Object.assign(
			{
				write: (data: any) => sink.write(data),
				flush: () => sink.flush(),
				end: (err?: any) => sink.end(err),
				start: (options?: any) => sink.start(options),
				ref: () => sink.ref(),
				unref: () => sink.unref(),
			},
			overrides
		) as Sink;
	}

	/** A promise plus the function that settles it, for holding an operation open. */
	function gate(): { wait: Promise<void>; open: () => void } {
		let open!: () => void;
		const wait = new Promise<void>(resolve => (open = resolve));
		return { wait, open };
	}

	/** Whether something finished within a couple of seconds, rather than never. */
	async function bounded(work: Promise<unknown>): Promise<string> {
		return Promise.race([work.then(() => 'swept'), Bun.sleep(2000).then(() => 'never returned')]);
	}

	function handlersFor(limits: UploadLimits): { handlers: ReturnType<typeof initUploadHandlers>; uploadDir: string } {
		const dataDir = join(tmpdir(), `lish-upload-state-${crypto.randomUUID()}`);
		tempDirs.push(dataDir);
		return { handlers: initUploadHandlers(dataDir, { sweepIntervalMs: 0, ...limits }), uploadDir: join(dataDir, 'tmp') };
	}

	it('does not expire an upload whose chunk is still reaching the disk', async () => {
		// Idle from the instant it is touched, so anything the sweep is allowed to
		// take, it takes.
		const { handlers, uploadDir } = handlersFor({ idleMs: 0, maxAgeMs: 60_000 });
		const client = {};
		const held = gate();
		nextSink = sink =>
			wrapSink(sink, {
				flush: async () => {
					await held.wait;
					return sink.flush();
				},
			});
		const { uploadID } = await handlers.begin({ name: 'slow-flush.lish' }, client);
		// `receiveChunk` stays in `receiving` across its write and its flush, so the
		// state alone says "idle" while the handler is still writing. The sweep used
		// to close the writer and delete the file underneath it, after which the
		// chunk still answered with a byte count for an upload that no longer existed.
		const writing = handlers.chunk({ uploadID, data: pattern(4096) }, client);
		await Bun.sleep(20);
		await handlers.sweep();
		held.open();

		expect(await writing).toEqual({ received: 4096 });
		expect((await readdir(uploadDir)).length).toBe(1);
		// Still a real upload afterwards, not merely a surviving file.
		expect(await handlers.end({ uploadID }, client)).toEqual({ uploadID });
		expect((await handlers.withFile({ uploadID }, client, async path => Bun.file(path).size)) as number).toBe(4096);
		handlers.stop();
	});

	it('does not answer an abort before the operation it interrupts is over', async () => {
		const { handlers, uploadDir } = handlersFor({});
		const client = {};
		const held = gate();
		nextSink = sink =>
			wrapSink(sink, {
				flush: async () => {
					await held.wait;
					return sink.flush();
				},
			});
		const { uploadID } = await handlers.begin({ name: 'aborted.lish' }, client);
		const writing = handlers.chunk({ uploadID, data: pattern(4096) }, client).catch(() => 'stopped');
		await Bun.sleep(20);

		let settled = false;
		const aborting = handlers.abort({ uploadID }, client).then(() => (settled = true));
		await Bun.sleep(50);
		// The frontend starts its next transfer the moment this returns, so it may
		// not return while the file it promises is gone is still being written to.
		expect(settled).toBe(false);

		held.open();
		await aborting;
		await writing;
		expect(settled).toBe(true);
		// Gone by the time the abort answered, not merely gone eventually.
		expect(await readdir(uploadDir)).toEqual([]);
		handlers.stop();
	});

	it('joins a repeated end to the finalisation already running', async () => {
		const { handlers } = handlersFor({});
		const client = {};
		const held = gate();
		nextSink = sink =>
			wrapSink(sink, {
				end: async (err?: any) => {
					await held.wait;
					return sink.end(err);
				},
			});
		const { uploadID } = await handlers.begin({ name: 'slow-close.lish' }, client);
		await handlers.chunk({ uploadID, data: pattern(2048) }, client);
		const first = handlers.end({ uploadID }, client);
		await Bun.sleep(20);
		// The retry the frontend sends once its step timeout fires. This came back
		// UPLOAD_BUSY before, the helper read that as final and aborted — and the
		// first `end` then finished the file successfully and deleted it again.
		const retry = handlers.end({ uploadID }, client);
		held.open();

		expect(await first).toEqual({ uploadID });
		expect(await retry).toEqual({ uploadID });
		expect((await handlers.withFile({ uploadID }, client, async path => Bun.file(path).size)) as number).toBe(2048);
		handlers.stop();
	});

	it('reports a failed close to a retried end rather than a success', async () => {
		const { handlers, uploadDir } = handlersFor({});
		const client = {};
		const held = gate();
		nextSink = sink =>
			wrapSink(sink, {
				end: async () => {
					await held.wait;
					throw new Error('handle is gone');
				},
			});
		const { uploadID } = await handlers.begin({ name: 'bad-close.lish' }, client);
		await handlers.chunk({ uploadID, data: pattern(1024) }, client);
		const first = handlers.end({ uploadID }, client).catch(err => err.message);
		await Bun.sleep(20);
		const retry = handlers.end({ uploadID }, client).catch(err => err.code);
		held.open();

		expect(await first).toBe('handle is gone');
		// The join answers from where the first call landed. A partial file is not
		// a finished upload, whichever call is asking.
		expect(await retry).toBe(ErrorCodes.UPLOAD_NOT_FOUND);
		expect(await readdir(uploadDir)).toEqual([]);
		handlers.stop();
	});

	it('keeps sweeping when a cleanup never finishes closing its writer', async () => {
		const { handlers, uploadDir } = handlersFor({ idleMs: 0, maxAgeMs: 0 });
		const client = {};
		const wedged = gate();
		nextSink = sink =>
			wrapSink(sink, {
				end: async () => {
					await wedged.wait;
					return sink.end();
				},
			});
		const { uploadID } = await handlers.begin({ name: 'wedged.lish' }, client);
		await handlers.chunk({ uploadID, data: pattern(64) }, client);
		// Moves the record into `cleanup` and leaves it there, because the close it
		// is waiting on never returns.
		const stuck = handlers.abort({ uploadID }, client).catch(() => 'stuck');
		await Bun.sleep(20);

		// Awaiting that cleanup would hold this pass open for good — and the
		// single-flight guard would then mean no sweep ever ran again.
		const orphan = join(uploadDir, 'orphan.lish');
		await Bun.write(orphan, 'left behind');
		const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
		await utimes(orphan, longAgo, longAgo);
		// Raced against a deadline rather than simply awaited: without the fix this
		// pass never returns, and a test that hangs the run says far less than one
		// that fails it.
		expect(await bounded(handlers.sweep())).toBe('swept');
		expect(await Bun.file(orphan).exists()).toBe(false);
		// And the next pass is not left blocked behind the first one either.
		expect(await bounded(handlers.sweep())).toBe('swept');

		wedged.open();
		await stuck;
		handlers.stop();
	});

	it('keeps sweeping when the sweep itself starts a cleanup that wedges', async () => {
		const { handlers, uploadDir } = handlersFor({ idleMs: 0, maxAgeMs: 0 });
		const client = {};
		const wedged = gate();
		nextSink = sink =>
			wrapSink(sink, {
				end: async () => {
					await wedged.wait;
					return sink.end();
				},
			});
		const { uploadID } = await handlers.begin({ name: 'idle-wedged.lish' }, client);

		const orphan = join(uploadDir, 'orphan-after-wedge.lish');
		await Bun.write(orphan, 'left behind');
		const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
		await utimes(orphan, longAgo, longAgo);

		// This pass is the one that starts the stuck writer close. It must still
		// finish its orphan scan, and its single-flight promise must settle so a
		// later pass can run as well.
		expect(await bounded(handlers.sweep())).toBe('swept');
		expect(await Bun.file(orphan).exists()).toBe(false);
		expect(await bounded(handlers.sweep())).toBe('swept');

		wedged.open();
		await handlers.abort({ uploadID }, client);
		handlers.stop();
	});

	for (const failing of ['write', 'flush'] as const) {
		it(`ends an upload whose ${failing} failed instead of leaving it open`, async () => {
			const budget = 64 * 1024;
			const { handlers, uploadDir } = handlersFor({ maxTotalBytes: budget });
			const client = {};
			nextSink = sink =>
				wrapSink(sink, {
					[failing]: () => {
						throw new Error('the disk went away');
					},
				});
			const { uploadID } = await handlers.begin({ name: 'doomed.lish' }, client);
			// The counters are raised before the write, which is what makes the quota
			// reservation atomic. A write that then fails leaves a file that is short
			// or shifted, and the transfer used to stay open over it — the next chunk
			// was accepted and `end` would happily mark the result `ready`.
			await expect(handlers.chunk({ uploadID, data: pattern(1024) }, client)).rejects.toThrow('the disk went away');
			await expect(handlers.chunk({ uploadID, data: pattern(16) }, client)).rejects.toThrow(ErrorCodes.UPLOAD_NOT_FOUND);
			await expect(handlers.end({ uploadID }, client)).rejects.toThrow(ErrorCodes.UPLOAD_NOT_FOUND);
			expect(await readdir(uploadDir)).toEqual([]);
			// And the bytes it had already claimed came back with the file, rather
			// than being charged to the budget for the rest of the process's life.
			const { uploadID: next } = await handlers.begin({ name: 'next.lish' }, client);
			expect(await handlers.chunk({ uploadID: next, data: pattern(budget) }, client)).toEqual({ received: budget });
			handlers.stop();
		});
	}
});
