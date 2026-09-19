import { describe, expect, it } from 'bun:test';
import { CodedError, ErrorCodes } from '@shared';
import { initLISHsHandlers } from '../../../src/api/lishs.ts';

/**
 * Adding a peer's LISH takes the mutation gate once, at its public entry, and then runs a
 * manifest download that can take a while. The import pipeline it finishes with used to
 * take the same gate again — so a factory reset closing admission mid-download made an
 * operation that was already accepted refuse its own second half.
 *
 * The gate has no re-entrancy: {@link LISHMutationGate.tryEnter} answers on the closed
 * flag alone, with no idea that the caller is already inside. The fix is the admitted
 * variant, the pattern the finalize path already uses.
 */

function createHandlers(): ReturnType<typeof initLISHsHandlers> {
	return initLISHsHandlers(
		{} as never,
		() => {},
		() => {},
		{} as never
	);
}

const MANIFEST = { lishID: 'a'.repeat(64), name: 'x', files: [], directories: [] } as never;

function isPausedError(error: unknown): boolean {
	return error instanceof CodedError && error.code === ErrorCodes.INTERNAL_ERROR && String((error as CodedError).message).includes('paused');
}

describe('importing a manifest from inside the mutation gate', () => {
	it('refuses the gated entry point once admission is closed', async () => {
		const handlers = createHandlers();
		await handlers.pauseMutations();

		const error = await handlers.importManifest(MANIFEST, '/tmp').then(
			() => null,
			(err: unknown) => err
		);
		expect(isPausedError(error)).toBe(true);
	});

	it('lets an already-admitted caller finish through the admitted entry point', async () => {
		const handlers = createHandlers();
		await handlers.pauseMutations();

		// It still fails — this fixture has no data server — but on its own work, not on the
		// gate. Before the fix this was the refusal above, reached from inside a held permit.
		const error = await handlers.importManifestAdmitted(MANIFEST, '/tmp').then(
			() => null,
			(err: unknown) => err
		);
		expect(error).not.toBeNull();
		expect(isPausedError(error)).toBe(false);
	});

	it('leaves the gate empty after a gated import, so a later drain and reopen work', async () => {
		const handlers = createHandlers();
		// An operation that enters must leave exactly as many times as it entered. A permit
		// left behind keeps `active` above zero: the drain below would never resolve and the
		// reopen would throw instead.
		await handlers.importManifest(MANIFEST, '/tmp').catch(() => {});
		await handlers.pauseMutations();
		handlers.resumeMutations();

		const error = await handlers.importManifest(MANIFEST, '/tmp').then(
			() => null,
			(err: unknown) => err
		);
		expect(isPausedError(error)).toBe(false);
	});
});
