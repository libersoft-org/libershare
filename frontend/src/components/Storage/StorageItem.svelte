<script lang="ts">
	import TableRow from '../Table/TableRow.svelte';
	import TableCell from '../Table/TableCell.svelte';
	import Icon from '../Icon/Icon.svelte';
	import { type StorageItemType, getStorageIcon } from '../../scripts/storage.ts';

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
</script>

<style>
	.name {
		font-size: 2vh;
		font-weight: bold;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		display: flex;
		align-items: center;
		gap: 1vh;
	}
</style>

<TableRow {selected} {odd}>
	<TableCell>
		<div class="name">
			<Icon img={getStorageIcon(type)} size="2vh" padding="0" colorVariable={selected ? '--primary-background' : '--secondary-foreground'} />
			<span>{name}</span>
		</div>
	</TableCell>
	<TableCell align="right" desktopOnly>{size ?? '—'}</TableCell>
	<TableCell align="right" desktopOnly>{modified ?? '—'}</TableCell>
</TableRow>
