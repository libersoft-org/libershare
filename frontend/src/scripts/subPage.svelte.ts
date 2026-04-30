import { tick } from 'svelte';
import { type NavAreaHandle } from './navArea.svelte.ts';
import { activateArea } from './areas.ts';
import { pushBreadcrumb, popBreadcrumb } from './navigation.ts';
import { pushBackHandler } from './focus.ts';

/**
 * Sub-page navigation helper. Encapsulates the pause/breadcrumb/back-handler
 * dance used whenever a page opens an embedded sub-view (FileBrowser, sub-form,
 * detail view, etc.).
 *
 * Lifecycle:
 *   enter(label[, onBack]):
 *     - navHandle.pause()
 *     - pushBreadcrumb(label)
 *     - pushBackHandler(onBack ?? defaultBack)  (defaultBack calls exit())
 *     - active = true
 *
 *   exit():
 *     - removes back handler
 *     - popBreadcrumb()
 *     - active = false
 *     - await tick()
 *     - navHandle.resume()
 *     - activateArea(areaID)
 *
 * Each instance owns one sub-page. If a page has multiple sub-pages
 * (e.g. browse + edit + export), create one SubPage per sub-page so their
 * states do not collide.
 */
export interface SubPage {
	/**
	 * Open the sub-page. Pauses parent navigation, pushes a breadcrumb segment,
	 * and registers a global Back handler. If `onBack` is provided it replaces
	 * the default back handler (which simply calls `exit()`). Custom handlers
	 * are responsible for calling `exit()` themselves when appropriate.
	 */
	enter(label: string, onBack?: () => void | Promise<void>): void;
	/** Close the sub-page and resume parent navigation. Idempotent. */
	exit(): Promise<void>;
	/** Reactive flag indicating whether the sub-page is currently open. */
	readonly active: boolean;
}

export function createSubPage(navHandle: NavAreaHandle, getAreaID: () => string): SubPage {
	let active = $state(false);
	let removeBackHandler: (() => void) | null = null;

	async function exit(): Promise<void> {
		if (!active) return;
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		active = false;
		await tick();
		navHandle.resume();
		activateArea(getAreaID());
	}

	function enter(label: string, onBack?: () => void | Promise<void>): void {
		if (active) return;
		active = true;
		navHandle.pause();
		pushBreadcrumb(label);
		const handler = onBack ?? ((): void => void exit());
		removeBackHandler = pushBackHandler(() => {
			void handler();
		});
	}

	return {
		enter,
		exit,
		get active(): boolean {
			return active;
		},
	};
}
