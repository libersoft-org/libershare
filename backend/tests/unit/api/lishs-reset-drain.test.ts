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
});
