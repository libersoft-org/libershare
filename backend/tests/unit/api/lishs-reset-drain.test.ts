import { describe, expect, it, spyOn } from 'bun:test';
import { CodedError, ErrorCodes } from '@shared';
import { initLISHsHandlers } from '../../../src/api/lishs.ts';

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
