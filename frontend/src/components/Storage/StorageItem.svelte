<script lang="ts">
	import TableRow from '../Table/TableRow.svelte';
	import TableCell from '../Table/TableCell.svelte';
	import type { StorageItemType } from './types.ts';

	interface Props {
		name: string;
		type: StorageItemType;
		size?: string;
		modified?: string;
		selected?: boolean;
		isLast?: boolean;
		odd?: boolean;
	}
	let { name, type, size, modified, selected = false, isLast = false, odd = false }: Props = $props();

	function getIcon(type: StorageItemType): string {
		if (type === 'drive') return '/img/storage.svg';
		if (type === 'folder') return '/img/folder.svg';
		return '/img/file.svg';
	}
</script>

<style>
	.name {
		font-size: 2vh;
		font-weight: bold;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.icon {
		display: inline-block;
		margin-right: 1vh;
		height: 1.6vh;
		width: 1.6vh;
		vertical-align: middle;
	}

	.emoji {
		display: inline-block;
		margin-right: 1vh;
		font-size: 1.6vh;
	}
</style>

<TableRow {selected} {odd}>
	<TableCell>
		<div class="name">
			<img class="icon" src={getIcon(type)} alt="" />
			<span>{name}</span>
		</div>
	</TableCell>
	<TableCell align="right" desktopOnly>{size ?? '—'}</TableCell>
	<TableCell align="right" desktopOnly>{modified ?? '—'}</TableCell>
</TableRow>
