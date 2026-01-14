<script lang="ts">
	import TableRow from '../Table/TableRow.svelte';
	import TableCell from '../Table/TableCell.svelte';
	import Table from '../Table/Table.svelte';
	import ItemDetail from '../Download/DownloadItemDetail.svelte';
	import { t } from '../../scripts/language.ts';
	import type { StorageItemType, StorageItemData } from './Storage.svelte';

	interface Props {
		name: string;
		type: StorageItemType;
		size?: string;
		modified: string;
		children?: StorageItemData[];
		selected?: boolean;
		expanded?: boolean;
		selectedChildIndex?: number;
		isLast?: boolean;
		odd?: boolean;
	}
	let { name, type, size, modified, children, selected = false, expanded = false, selectedChildIndex = -1, isLast = false, odd = false }: Props = $props();

	const hasChildren = $derived(type === 'folder' && children && children.length > 0);
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
		font-size: 1.6vh;
	}

	.expand {
		display: inline-block;
		margin-right: 0.5vh;
		transition: transform 0.2s ease;
		font-size: 1.2vh;
		opacity: 0.6;
	}

	.expand.expanded {
		transform: rotate(90deg);
	}

	.expand.hidden {
		visibility: hidden;
	}

	.details {
		display: none;
		padding: 0vh 1vh;
		font-size: 1.6vh;
	}

	@media (max-width: 1199px) {
		.details.show {
			display: block;
		}
	}
</style>

<TableRow selected={selected && selectedChildIndex === -1} {odd}>
	<TableCell>
		<div class="name">
			<span class="expand" class:expanded class:hidden={!hasChildren}>▶</span>
			<span class="icon">{type === 'folder' ? '📁' : '📄'}</span>
			<span>{name}</span>
		</div>
	</TableCell>
	<TableCell align="right" desktopOnly>{size ?? '—'}</TableCell>
	<TableCell align="right" desktopOnly>{modified}</TableCell>
</TableRow>
{#if expanded && hasChildren}
	<div class="details" class:show={expanded}>
		<ItemDetail label={$t.localStorage?.size}>{size ?? '—'}</ItemDetail>
		<ItemDetail label={$t.localStorage?.modified}>{modified}</ItemDetail>
	</div>
	<Table columns="1fr 8vw 12vw" columnsMobile="1fr" noBorder>
		{#each children as child, index (child.id)}
			<TableRow selected={selected && selectedChildIndex === index} odd={index % 2 === 0}>
				<TableCell>
					<div class="name">
						<span class="expand hidden">▶</span>
						<span class="icon">{child.type === 'folder' ? '📁' : '📄'}</span>
						<span>{child.name}</span>
					</div>
				</TableCell>
				<TableCell align="right" desktopOnly>{child.size ?? '—'}</TableCell>
				<TableCell align="right" desktopOnly>{child.modified}</TableCell>
			</TableRow>
		{/each}
	</Table>
{/if}
