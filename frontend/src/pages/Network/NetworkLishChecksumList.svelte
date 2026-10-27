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
		const line = el.scrollHeight / checksums.length;
		const page = Math.max(1, Math.floor(el.clientHeight / line) - 1);
		const lines: Record<NavAction, number> = { up: -1, down: 1, pageUp: -page, pageDown: page, home: -Infinity, end: Infinity, left: 0, right: 0 };
		const by = lines[action];
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
