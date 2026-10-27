<script lang="ts">
	import { type Snippet, getContext } from 'svelte';
	import type { NavAreaController, NavPos } from '../../scripts/navArea.svelte.ts';
	import Icon from '../../components/Icon/Icon.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	import { formatSize } from '../../scripts/utils.ts';
	interface Props {
		name: string;
		type: 'dir' | 'file' | 'link';
		size: number;
		depth: number;
		rowY: number;
		onConfirm?: (() => void) | undefined;
		/** Show {@link children} across the whole row below its cells. */
		expanded?: boolean | undefined;
		/** Details of the entry. */
		children?: Snippet | undefined;
	}
	let { name, type, size, depth, rowY, onConfirm, expanded = false, children }: Props = $props();
	const navArea = getContext<NavAreaController | undefined>('navArea');
	let position = $derived<NavPos>([0, rowY]);
	let isSelected = $derived(navArea ? navArea.isSelected(position) : false);
	let typeIcon = $derived(type === 'dir' ? '/img/directory.svg' : type === 'link' ? '/img/link.svg' : '/img/file.svg');
	let iconColor = $derived(isSelected ? '--primary-background' : '--secondary-foreground');
	let sizeDisplay = $derived(type === 'file' ? formatSize(size) : '');
	let el = $state<HTMLElement | undefined>();
	// Opened details (and checksums arriving later) grow the row past the spot the selection scrolled to.
	// Only while it is selected: a late answer must not pull the view back from where the user went since.
	$effect(() => {
		if (!expanded || !el || !isSelected) return;
		const row = el;
		const observer = new ResizeObserver(() => row.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
		observer.observe(row);
		return () => observer.disconnect();
	});
</script>

<style>
	.name {
		font-size: 1.8vh;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		display: flex;
		align-items: center;
		gap: 0.5vh;
	}

	.indent {
		display: inline-block;
		flex-shrink: 0;
	}

	.details {
		grid-column: 1 / -1;
		min-width: 0;
	}
</style>

<TableRow bind:el {position} {onConfirm}>
	<TableCell>
		<span class="name">
			<span class="indent" style="width: {depth * 2.5}vh"></span>
			<Icon img={typeIcon} size="1.8vh" padding="0" colorVariable={iconColor} />
			{name}
		</span>
	</TableCell>
	<TableCell align="right" width="12vh">{sizeDisplay}</TableCell>
	{#if expanded && children}
		<div class="details">{@render children()}</div>
	{/if}
</TableRow>
