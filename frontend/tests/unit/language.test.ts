/**
 * Unit tests for the translation-loader race guard in
 * `src/scripts/language.ts`.
 *
 * The factory under test is intentionally pure: it does not import
 * svelte/store, so these tests can run under `bun test` without dragging in
 * the SvelteKit runtime.
 */
import { test, expect } from 'bun:test';
import { createTranslationLoader } from '../../src/scripts/language.ts';

type Resolver = (value: any) => void;

interface DeferredLoader {
	loader: (langID: string) => Promise<any>;
	resolveAll: (langID: string, value: any) => void;
}

function deferredLoader(): DeferredLoader {
	const queues = new Map<string, Resolver[]>();
	const loader = (langID: string): Promise<any> =>
		new Promise<any>(resolve => {
			const list = queues.get(langID) ?? [];
			list.push(resolve);
			queues.set(langID, list);
		});
	const resolveAll = (langID: string, value: any): void => {
		const list = queues.get(langID) ?? [];
		for (const r of list) r(value);
		queues.set(langID, []);
	};
	return { loader, resolveAll };
}

test('applies translations for a single language change', async () => {
	const { loader, resolveAll } = deferredLoader();
	const applied: any[] = [];
	const handler = createTranslationLoader(loader, data => applied.push(data));
	const p = handler('cs');
	resolveAll('cs', { lang: 'cs' });
	await p;
	expect(applied).toEqual([{ lang: 'cs' }]);
});

test('discards a stale fetch when a newer language is selected', async () => {
	const { loader, resolveAll } = deferredLoader();
	const applied: any[] = [];
	const handler = createTranslationLoader(loader, data => applied.push(data));

	const pEn = handler('en');
	const pCs = handler('cs');

	// Resolve cs first — handler for cs should apply.
	resolveAll('cs', { lang: 'cs' });
	await pCs;
	expect(applied).toEqual([{ lang: 'cs' }]);

	// Now resolve the older en fetch. pendingLangID is 'cs', so en is stale.
	resolveAll('en', { lang: 'en' });
	await pEn;
	expect(applied).toEqual([{ lang: 'cs' }]);
});

test('discards a stale fetch even when it resolves before the newer one', async () => {
	const { loader, resolveAll } = deferredLoader();
	const applied: any[] = [];
	const handler = createTranslationLoader(loader, data => applied.push(data));

	const pEn = handler('en');
	const pCs = handler('cs');

	// Resolve en (older request) first. Because pendingLangID is now 'cs',
	// the en result must be discarded.
	resolveAll('en', { lang: 'en' });
	await pEn;
	expect(applied).toEqual([]);

	resolveAll('cs', { lang: 'cs' });
	await pCs;
	expect(applied).toEqual([{ lang: 'cs' }]);
});

test('rapid back-and-forth changes converge on the final selection', async () => {
	const { loader, resolveAll } = deferredLoader();
	const applied: any[] = [];
	const handler = createTranslationLoader(loader, data => applied.push(data));

	// Three changes in quick succession before any fetch resolves.
	const pA = handler('en');
	const pB = handler('cs');
	const pC = handler('en');

	// Resolve out of order: cs (stale), then both en calls.
	resolveAll('cs', { lang: 'cs' });
	await pB;
	expect(applied).toEqual([]);

	// All en resolutions match pendingLangID === 'en'. Each resolved fetch
	// applies the result; both are 'en' so the final state is consistent.
	resolveAll('en', { lang: 'en' });
	await Promise.all([pA, pC]);
	expect(applied).toEqual([{ lang: 'en' }, { lang: 'en' }]);
});

test('reselecting the same language still applies', async () => {
	const { loader, resolveAll } = deferredLoader();
	const applied: any[] = [];
	const handler = createTranslationLoader(loader, data => applied.push(data));

	const p1 = handler('cs');
	resolveAll('cs', { v: 1 });
	await p1;
	expect(applied).toEqual([{ v: 1 }]);

	const p2 = handler('cs');
	resolveAll('cs', { v: 2 });
	await p2;
	expect(applied).toEqual([{ v: 1 }, { v: 2 }]);
});
