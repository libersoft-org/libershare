<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { type NavAction, type NavAreaController, navItem } from '../../scripts/navArea.svelte.ts';
	interface Props {
		checksums: string[];
		/**
		 * Position in the surrounding navArea. While selected, the list scrolls with the arrows and
		 * paging keys and hands the move on once it reaches its end. Without it the list only scrolls by mouse.
		 */
		y?: number | undefined;
	}
	let { checksums, y }: Props = $props();
	const navArea = getContext<NavAreaController | undefined>('navArea');
	let el = $state<HTMLElement | undefined>();
	let isSelected = $derived(navArea && y !== undefined ? navArea.isSelected([0, y]) : false);
	// One text node rather than a row each: a large file has tens of thousands of chunks.
	let text = $derived(checksums.map((checksum, i) => `${i + 1}\t${checksum}`).join('\n'));

	function onNavigate(action: NavAction): boolean {
		if (!el || checksums.length === 0) return false;
		// A long checksum (e.g. SHA-512) can be wider than the box; left/right reveal its end.
		if (action === 'left' || action === 'right') {
			const left = el.scrollLeft;
			const maxLeft = el.scrollWidth - el.clientWidth;
			if (action === 'left' ? left <= 0 : left >= maxLeft - 1) return false;
			const step = Math.max(1, Math.floor(el.clientWidth / 4));
			el.scrollLeft = Math.max(0, Math.min(maxLeft, left + (action === 'left' ? -step : step)));
			return true;
		}
		const line = el.scrollHeight / checksums.length;
		const page = Math.max(1, Math.floor(el.clientHeight / line) - 1);
		const lines: Partial<Record<NavAction, number>> = { up: -1, down: 1, pageUp: -page, pageDown: page, home: -Infinity, end: Infinity };
		const by = lines[action] ?? 0;
		const top = el.scrollTop;
		const max = el.scrollHeight - el.clientHeight;
		if (by === 0 || (by < 0 ? top <= 0 : top >= max - 1)) return false;
		el.scrollTop = Math.max(0, Math.min(max, top + by * line));
		return true;
	}

	onMount(() => {
		if (!navArea || y === undefined) return undefined;
		const item = navItem(
			() => [0, y!],
			() => el
		);
		item.onNavigate = onNavigate;
		return navArea.register(item);
	});
</script>

<style>
	.checksums {
		max-height: 30vh;
		overflow-y: auto;
		white-space: pre;
		font-family: var(--font-mono);
		font-size: 1.5vh;
	}

	.checksums.selected {
		outline: 0.3vh solid var(--primary-foreground);
	}
</style>

<div bind:this={el} class="checksums" class:selected={isSelected}>{text}</div>
