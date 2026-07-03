/**
 * Unit tests for the back-navigation routing logic introduced in DownloadLISHCreate.
 *
 * The goBack() helper decides how to navigate Back based on whether
 * a custom backPathIDs was provided (absolute path override) or a plain
 * onBack callback, falling back to navigateBack() otherwise.
 *
 * The logic is pure dispatch — tested here in isolation without Svelte runtime.
 */
import { test, expect } from 'bun:test';

/** Mirrors the goBack() logic from DownloadLISHCreate. */
function makeGoBack(opts: { backPathIDs?: string[] | undefined; onBack?: (() => void) | undefined; navigateToAbsolutePath: (ids: string[]) => void; navigateBack: () => void }): () => void {
	return function goBack(): void {
		if (opts.backPathIDs) opts.navigateToAbsolutePath(opts.backPathIDs);
		else if (opts.onBack) opts.onBack();
		else opts.navigateBack();
	};
}

test('uses navigateToAbsolutePath when backPathIDs is provided', () => {
	const calls: string[] = [];
	const goBack = makeGoBack({
		backPathIDs: ['localStorage'],
		onBack: () => calls.push('onBack'),
		navigateToAbsolutePath: ids => calls.push('absolute:' + ids.join('/')),
		navigateBack: () => calls.push('back'),
	});
	goBack();
	expect(calls).toEqual(['absolute:localStorage']);
});

test('uses onBack callback when backPathIDs is absent but onBack is set', () => {
	const calls: string[] = [];
	const goBack = makeGoBack({
		backPathIDs: undefined,
		onBack: () => calls.push('onBack'),
		navigateToAbsolutePath: ids => calls.push('absolute:' + ids.join('/')),
		navigateBack: () => calls.push('back'),
	});
	goBack();
	expect(calls).toEqual(['onBack']);
});

test('falls back to navigateBack when neither backPathIDs nor onBack is provided', () => {
	const calls: string[] = [];
	const goBack = makeGoBack({
		backPathIDs: undefined,
		onBack: undefined,
		navigateToAbsolutePath: ids => calls.push('absolute:' + ids.join('/')),
		navigateBack: () => calls.push('back'),
	});
	goBack();
	expect(calls).toEqual(['back']);
});

test('multi-segment backPathIDs are passed verbatim to navigateToAbsolutePath', () => {
	const captured: string[][] = [];
	const goBack = makeGoBack({
		backPathIDs: ['downloads', 'create-lish'],
		navigateToAbsolutePath: ids => {
			captured.push(ids);
		},
		navigateBack: () => {},
	});
	goBack();
	expect(captured).toEqual([['downloads', 'create-lish']]);
});
