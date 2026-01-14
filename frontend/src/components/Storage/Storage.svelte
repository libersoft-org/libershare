<script lang="ts">
	import { onMount } from 'svelte';
	import { useArea, activateArea, activeArea } from '../../scripts/areas.ts';
	import { t } from '../../scripts/language.ts';
	import Table from '../Table/Table.svelte';
	import Header from '../Table/TableHeader.svelte';
	import Cell from '../Table/TableCell.svelte';
	import StorageItem from './StorageItem.svelte';
	export type StorageItemType = 'folder' | 'file';
	export interface StorageItemData {
		id: string;
		name: string;
		type: StorageItemType;
		size?: string;
		modified: string;
		children?: StorageItemData[];
	}
	interface Props {
		areaID: string;
		title?: string;
		onBack?: () => void;
	}
	const columns = '1fr 8vw 12vw';
	let { areaID, title = 'Storage', onBack }: Props = $props();
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0);
	let expandedIndex = $state<number | null>(null);
	let selectedChildIndex = $state(-1); // -1 = main row selected, 0+ = child selected
	let itemElements: HTMLElement[] = $state([]);

	// Mock data - directory structure
	const items: StorageItemData[] = [
		{
			id: '1',
			name: 'Software',
			type: 'folder',
			modified: '2024-01-12',
			children: [
				{ id: '1-1', name: 'ubuntu-24.04-desktop-amd64.iso', type: 'file', size: '4.1 GB', modified: '2024-01-12' },
				{ id: '1-2', name: 'fedora-40-workstation.iso', type: 'file', size: '2.1 GB', modified: '2024-01-11' },
			],
		},
		{
			id: '2',
			name: 'readme.txt',
			type: 'file',
			size: '2.4 KB',
			modified: '2024-01-01',
		},
	];

	function scrollToSelected(): void {
		const element = itemElements[selectedIndex];
		if (element) {
			element.scrollIntoView({
				behavior: 'smooth',
				block: 'center',
			});
		}
	}

	const areaHandlers = {
		up: () => {
			if (expandedIndex === selectedIndex && selectedChildIndex > -1) {
				selectedChildIndex--;
				return true;
			}
			if (selectedIndex > 0) {
				selectedIndex--;
				selectedChildIndex = -1;
				scrollToSelected();
				return true;
			}
			return false;
		},
		down: () => {
			if (expandedIndex === selectedIndex) {
				const childCount = items[selectedIndex].children?.length ?? 0;
				if (selectedChildIndex < childCount - 1) {
					selectedChildIndex++;
					return true;
				}
			}
			if (selectedIndex < items.length - 1) {
				selectedIndex++;
				selectedChildIndex = -1;
				scrollToSelected();
				return true;
			}
			return false;
		},
		left: () => false,
		right: () => false,
		confirmDown: () => {},
		confirmUp: () => {
			const item = items[selectedIndex];
			if (item.type === 'folder' && item.children?.length) {
				if (expandedIndex === selectedIndex) {
					expandedIndex = null;
					selectedChildIndex = -1;
				} else {
					expandedIndex = selectedIndex;
					selectedChildIndex = -1;
				}
			}
		},
		confirmCancel: () => {},
		back: () => {
			if (expandedIndex !== null) {
				expandedIndex = null;
				selectedChildIndex = -1;
			} else {
				onBack?.();
			}
		},
	};

	onMount(() => {
		const unregister = useArea(areaID, areaHandlers);
		activateArea(areaID);
		return unregister;
	});
</script>

<style>
	.items {
		flex: 1;
		overflow-y: auto;
		font-size: 1.4vh;
	}
</style>

<Table {columns} noBorder>
	<Header>
		<Cell>{$t.localStorage?.name}</Cell>
		<Cell align="right" desktopOnly>{$t.localStorage?.size}</Cell>
		<Cell align="right" desktopOnly>{$t.localStorage?.modified}</Cell>
	</Header>
	<div class="items">
		{#each items as item, index (item.id)}
			<div bind:this={itemElements[index]}>
				<StorageItem name={item.name} type={item.type} size={item.size} modified={item.modified} children={item.children} selected={active && selectedIndex === index} expanded={expandedIndex === index} selectedChildIndex={selectedIndex === index ? selectedChildIndex : -1} isLast={index === items.length - 1} odd={index % 2 === 0} />
			</div>
		{/each}
	</div>
</Table>
