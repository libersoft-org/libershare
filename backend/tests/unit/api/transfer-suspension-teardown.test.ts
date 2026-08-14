import { describe, it, expect, beforeEach } from 'bun:test';
import { removeDownloadState, setNetworkSuspendedRef, setActiveDownloadersRef } from '../../../src/api/transfer.ts';

/**
 * A download suspended by leaving its last lishnet keeps a resume claim so a re-join
 * can restart it. Deleting the LISH must retract that claim: the map outlives the
 * LISH otherwise, so every later join retries an id that no longer exists — and a
 * re-import of the same id would resume a download the user never re-requested.
 */
describe('removeDownloadState — suspended resume claim', () => {
	let suspended: Map<string, Set<string>>;

	beforeEach(() => {
		suspended = new Map();
		setNetworkSuspendedRef(suspended);
		setActiveDownloadersRef(new Map());
	});

	it('drops the resume claim of the deleted LISH', async () => {
		suspended.set('lish-deleted', new Set(['net-a']));

		await removeDownloadState('lish-deleted');

		expect(suspended.has('lish-deleted')).toBe(false);
	});

	it('leaves other LISHs’ resume claims alone', async () => {
		suspended.set('lish-deleted', new Set(['net-a']));
		suspended.set('lish-kept', new Set(['net-a']));

		await removeDownloadState('lish-deleted');

		expect([...suspended.keys()]).toEqual(['lish-kept']);
	});

	it('is a no-op for a LISH that was never suspended', async () => {
		suspended.set('lish-kept', new Set(['net-a']));

		await removeDownloadState('lish-other');

		expect([...suspended.keys()]).toEqual(['lish-kept']);
	});
});
