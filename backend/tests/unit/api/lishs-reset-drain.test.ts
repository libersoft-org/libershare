import { describe, expect, it, spyOn } from 'bun:test';
import { CodedError, ErrorCodes } from '@shared';
import { initLISHsHandlers } from '../../../src/api/lishs.ts';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

function createHandlers(dataServer: unknown = {}): ReturnType<typeof initLISHsHandlers> {
	return initLISHsHandlers(
		dataServer as never,
		() => {},
		() => {},
		{} as never
	);
}

describe('LISH factory-reset mutation drain', () => {
	it('closes admission synchronously and waits for an admitted mutation', async () => {
		const handlers = createHandlers();
		let mutationStarted!: () => void;
		let releaseMutation!: () => void;
		const mutationEntered = new Promise<void>(resolve => {
			mutationStarted = resolve;
		});
		const mutationBlocked = new Promise<void>(resolve => {
			releaseMutation = resolve;
		});
		const mutation = handlers.runMutation(async () => {
			mutationStarted();
			await mutationBlocked;
			return 'done';
		});
		await mutationEntered;

		let drained = false;
		const pausing = handlers.pauseMutations().then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);

		let rejectedOperationRan = false;
		const rejected = await handlers
			.runMutation(async () => {
				rejectedOperationRan = true;
			})
			.catch(error => error);
		expect(rejected).toBeInstanceOf(CodedError);
		expect((rejected as CodedError).code).toBe(ErrorCodes.INTERNAL_ERROR);
		expect(rejectedOperationRan).toBe(false);

		releaseMutation();
		expect(await mutation).toBe('done');
		await pausing;
		expect(drained).toBe(true);

		handlers.resumeMutations();
		expect(await handlers.runMutation(async () => 42)).toBe(42);
	});

	it('aborts and drains a verifier before reset may wipe reused database ids', async () => {
		let existsStarted!: () => void;
		let releaseExists!: () => void;
		const existsEntered = new Promise<void>(resolve => {
			existsStarted = resolve;
		});
		const existsBlocked = new Promise<void>(resolve => {
			releaseExists = resolve;
		});
		const writes: string[] = [];
		const dataServer = {
			get: () => ({ id: 'verify-reset', directory: '/tmp/verify-reset', chunkSize: 1024, checksumAlgo: 'sha256' }),
			getFilesForVerification: () => [
				{
					path: 'file.bin',
					checksums: ['deadbeef'],
					chunkRowIDs: [7],
					fileInternalID: 3,
				},
			],
			markAllFileChunksFailed: () => writes.push('file-failed'),
			markChunkVerified: () => writes.push('chunk-verified'),
			markChunkFailed: () => writes.push('chunk-failed'),
		};
		const fileSpy = spyOn(Bun, 'file').mockImplementation(
			() =>
				({
					size: 1024,
					exists: async () => {
						existsStarted();
						await existsBlocked;
						return false;
					},
				}) as never
		);
		const handlers = createHandlers(dataServer);

		try {
			handlers.startVerification('verify-reset');
			await existsEntered;
			await handlers.pauseMutations();
			let drained = false;
			const stopping = handlers.stopVerifyAll().then(() => {
				drained = true;
			});
			await Promise.resolve();
			expect(drained).toBe(false);

			releaseExists();
			await stopping;

			expect(writes).toEqual([]);
		} finally {
			handlers.resumeMutations();
			fileSpy.mockRestore();
		}
	});
});

describe('stopping a creation that has not reached its hashing pass', () => {
	/** Enough of a settings reader for the create path; the chunk-size ceiling is all it reads. */
	const settingsStub = { get: (path: string) => (path === 'network.maxChunkSize' ? 100 * 1024 * 1024 : undefined) } as never;

	it('cancels a create still checking its path, so the gate can drain', async () => {
		const handlers = initLISHsHandlers(
			{} as never,
			() => {},
			() => {},
			settingsStub
		);
		const dir = await mkdtemp(join(tmpdir(), 'lish-create-stop-'));
		try {
			await writeFile(join(dir, 'payload.bin'), Buffer.alloc(64 * 1024, 7));

			// Same tick: the create has entered the mutation gate and is awaiting its path
			// checks, before the hashing call it hands the signal to. The controller has to be
			// registered by now, or this stop cancels nothing, the create runs to completion and
			// whoever waits for the gate to drain waits for the whole pass.
			const creating = handlers.create({ dataPath: dir }, null);
			await handlers.stopCreate();

			const outcome = await creating.then(
				() => 'finished',
				(err: unknown) => String((err as Error).message)
			);
			expect(outcome).toBe('LISH_CREATE_CANCELLED');

			// And the permit went with it: a close that still had to wait for the cancelled
			// operation would never resolve here.
			await handlers.pauseMutations();
			handlers.resumeMutations();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('does not read the directory it was told to stop scanning', async () => {
		const handlers = initLISHsHandlers(
			{} as never,
			() => {},
			() => {},
			settingsStub
		);
		// Empty on purpose: reading it is what the create would do next, and an empty directory
		// has its own error. Which error comes back says whether the read happened at all.
		const dir = await mkdtemp(join(tmpdir(), 'lish-create-stat-'));
		try {
			const creating = handlers.create({ dataPath: dir }, null);
			await handlers.stopCreate();

			const outcome = await creating.then(
				() => 'finished',
				(err: unknown) => String((err as Error).message)
			);
			// DIRECTORY_EMPTY would mean the cancelled creation went and listed the directory.
			expect(outcome).toBe('LISH_CREATE_CANCELLED');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('cancels only what the asking window started', async () => {
		const handlers = initLISHsHandlers(
			{} as never,
			() => {},
			() => {},
			settingsStub
		);
		const dirA = await mkdtemp(join(tmpdir(), 'lish-cancel-a-'));
		const dirB = await mkdtemp(join(tmpdir(), 'lish-cancel-b-'));
		// Two windows of the same node, each its own client on the socket.
		const windowA = { id: 'window-a' };
		const windowB = { id: 'window-b' };
		try {
			await writeFile(join(dirA, 'payload.bin'), Buffer.alloc(64 * 1024, 1));
			await writeFile(join(dirB, 'payload.bin'), Buffer.alloc(64 * 1024, 2));

			const creatingA = handlers.create({ dataPath: dirA }, windowA);
			const creatingB = handlers.create({ dataPath: dirB }, windowB);
			// A presses cancel while B is the newest creation: picking "the newest" would take
			// down the other window's work instead.
			await handlers.stopCreate(undefined, windowA);

			const outcomeA = await creatingA.then(
				() => 'finished',
				(err: unknown) => String((err as Error).message)
			);
			expect(outcomeA).toBe('LISH_CREATE_CANCELLED');

			// And a second cancel from A — the frontend sends one on the button and one when the
			// progress view unmounts — must not reach into B now that A's entry is gone.
			await handlers.stopCreate(undefined, windowA);
			const outcomeB = await creatingB.then(
				() => 'finished',
				(err: unknown) => String((err as Error).message)
			);
			expect(outcomeB).toBe('finished');
		} finally {
			await rm(dirA, { recursive: true, force: true });
			await rm(dirB, { recursive: true, force: true });
		}
	});

	it('cancels the newest of its own creations, not an older one', async () => {
		const handlers = initLISHsHandlers(
			{} as never,
			() => {},
			() => {},
			settingsStub
		);
		const older = await mkdtemp(join(tmpdir(), 'lish-cancel-older-'));
		const newer = await mkdtemp(join(tmpdir(), 'lish-cancel-newer-'));
		const window = { id: 'one-window' };
		try {
			await writeFile(join(older, 'payload.bin'), Buffer.alloc(64 * 1024, 1));
			await writeFile(join(newer, 'payload.bin'), Buffer.alloc(64 * 1024, 2));

			// One client, two creations: cancel means the one it is looking at, which is the last
			// it started — the same reach the single slot had before.
			const creatingOlder = handlers.create({ dataPath: older }, window);
			const creatingNewer = handlers.create({ dataPath: newer }, window);
			await handlers.stopCreate(undefined, window);

			const outcomes = await Promise.all([
				creatingOlder.then(
					() => 'finished',
					(err: unknown) => String((err as Error).message)
				),
				creatingNewer.then(
					() => 'finished',
					(err: unknown) => String((err as Error).message)
				),
			]);
			expect(outcomes).toEqual(['finished', 'LISH_CREATE_CANCELLED']);
		} finally {
			await rm(older, { recursive: true, force: true });
			await rm(newer, { recursive: true, force: true });
		}
	});

	it('does not fall back to an older creation once the cancelled one is gone', async () => {
		const handlers = initLISHsHandlers(
			{} as never,
			() => {},
			() => {},
			settingsStub
		);
		const older = await mkdtemp(join(tmpdir(), 'lish-repeat-older-'));
		const newer = await mkdtemp(join(tmpdir(), 'lish-repeat-newer-'));
		const window = { id: 'one-window' };
		try {
			await writeFile(join(older, 'payload.bin'), Buffer.alloc(64 * 1024, 1));
			await writeFile(join(newer, 'payload.bin'), Buffer.alloc(64 * 1024, 2));

			const creatingOlder = handlers.create({ dataPath: older }, window);
			const creatingNewer = handlers.create({ dataPath: newer }, window);
			await handlers.stopCreate(undefined, window);
			// The cancelled creation has unwound and left the bookkeeping. The second cancel the
			// progress view sends when it unmounts arrives now — with nothing of its own left to
			// stop, it must do nothing rather than take down the creation still under way.
			await creatingNewer.catch(() => {});
			await handlers.stopCreate(undefined, window);

			const outcomes = await Promise.all([
				creatingOlder.then(
					() => 'finished',
					(err: unknown) => String((err as Error).message)
				),
				creatingNewer.then(
					() => 'finished',
					(err: unknown) => String((err as Error).message)
				),
			]);
			expect(outcomes).toEqual(['finished', 'LISH_CREATE_CANCELLED']);
		} finally {
			await rm(older, { recursive: true, force: true });
			await rm(newer, { recursive: true, force: true });
		}
	});

	it('cancels every creation under way for maintenance, not just the last one', async () => {
		const handlers = initLISHsHandlers(
			{} as never,
			() => {},
			() => {},
			settingsStub
		);
		const first = await mkdtemp(join(tmpdir(), 'lish-create-a-'));
		const second = await mkdtemp(join(tmpdir(), 'lish-create-b-'));
		try {
			await writeFile(join(first, 'payload.bin'), Buffer.alloc(64 * 1024, 1));
			await writeFile(join(second, 'payload.bin'), Buffer.alloc(64 * 1024, 2));

			// Both are admitted; a single-slot register kept only the second, so the first went
			// on hashing after the stop and held its permit against the drain.
			const creatingFirst = handlers.create({ dataPath: first }, null);
			const creatingSecond = handlers.create({ dataPath: second }, null);
			await handlers.stopAllCreates();

			const outcomes = await Promise.all([
				creatingFirst.then(
					() => 'finished',
					(err: unknown) => String((err as Error).message)
				),
				creatingSecond.then(
					() => 'finished',
					(err: unknown) => String((err as Error).message)
				),
			]);
			expect(outcomes).toEqual(['LISH_CREATE_CANCELLED', 'LISH_CREATE_CANCELLED']);

			await handlers.pauseMutations();
			handlers.resumeMutations();
		} finally {
			await rm(first, { recursive: true, force: true });
			await rm(second, { recursive: true, force: true });
		}
	});
});
