<script lang="ts">
	import { getContext } from 'svelte';
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
	}
	let { name, type, size, depth, rowY }: Props = $props();
	const navArea = getContext<NavAreaController | undefined>('navArea');
	let position = $derived<NavPos>([0, rowY]);
	let isSelected = $derived(navArea ? navArea.isSelected(position) : false);
	let typeIcon = $derived(type === 'dir' ? '/img/directory.svg' : type === 'link' ? '/img/link.svg' : '/img/file.svg');
	let iconColor = $derived(isSelected ? '--primary-background' : '--secondary-foreground');
	let sizeDisplay = $derived(type === 'file' ? formatSize(size) : '');
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
</style>

<TableRow {position}>
	<TableCell>
		<span class="name">
			<span class="indent" style="width: {depth * 2.5}vh"></span>
			<Icon img={typeIcon} size="1.8vh" padding="0" colorVariable={iconColor} />
			{name}
		</span>
	</TableCell>
	<TableCell align="right" width="12vh">{sizeDisplay}</TableCell>
</TableRow>
