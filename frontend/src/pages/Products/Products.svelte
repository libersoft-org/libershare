<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { useArea, activateArea, activeArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_OFFSETS } from '../../scripts/navigationLayout.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { scrollToElement } from '../../scripts/utils.ts';
	import { getGridColumnsCount } from '../../scripts/products.ts';
	import SearchBar from '../../components/Search/SearchBar.svelte';
	import ProductsItem from './ProductsItem.svelte';
	import Product from '../Product/Product.svelte';
	interface Props {
		areaID: string;
		position: Position;
		title?: string;
		category?: string;
		onBack?: () => void;
	}
	let { areaID, position, title = 'Items', onBack }: Props = $props();
	let searchAreaID = $derived(`${areaID}-search`);
	let listAreaID = $derived(`${areaID}-list`);
	// Calculate sub-area positions based on base position
	let searchPosition = $derived({ x: position.x + CONTENT_OFFSETS.top.x, y: position.y + CONTENT_OFFSETS.top.y });
	let listPosition = $derived({ x: position.x + CONTENT_OFFSETS.main.x, y: position.y + CONTENT_OFFSETS.main.y });
	let searchSelected = $derived($activeArea === searchAreaID);
	let active = $derived($activeArea === listAreaID);
	// Some test data
	const items = Array.from({ length: 200 }, (_, i) => ({
		id: i + 1,
		title: 'Item ' + (i + 1),
	}));
	let selectedIndex = $state(0);
	let isAPressed = $state(false);
	let itemElements: HTMLElement[] = $state([]);
	let selectedItem = $state<{ id: number; title: string } | null>(null);
	let unregisterList: (() => void) | null = null;
	let searchBar: SearchBar | undefined = $state();

	// Use extracted grid columns function
	function getColumnsCount(): number {
		return getGridColumnsCount(itemElements);
	}

	function navigate(direction: string): void {
		const cols = getColumnsCount();
		switch (direction) {
			case 'up':
				selectedIndex = Math.max(0, selectedIndex - cols);
				break;
			case 'down':
				selectedIndex = Math.min(items.length - 1, selectedIndex + cols);
				break;
			case 'left':
				selectedIndex = Math.max(0, selectedIndex - 1);
				break;
			case 'right':
				selectedIndex = Math.min(items.length - 1, selectedIndex + 1);
				break;
		}
		scrollToSelectedItem();
	}

	function scrollToSelectedItem(instant = false): void {
		scrollToElement(itemElements, selectedIndex, instant);
	}

	function handleProductClick(index: number) {
		activateArea(listAreaID);
		selectedIndex = index;
		scrollToSelectedItem();
		openItem();
	}

	function openItem(): void {
		selectedItem = items[selectedIndex]!;
		pushBreadcrumb(items[selectedIndex]!.title);
		isAPressed = false;
		if (unregisterList) {
			unregisterList();
			unregisterList = null;
		}
	}

	async function closeDetail(): Promise<void> {
		selectedItem = null;
		popBreadcrumb();
		await tick();
		scrollToSelectedItem(true);
		unregisterList = useArea(listAreaID, areaHandlers, listPosition);
		activateArea(listAreaID);
	}

	const areaHandlers = {
		up() {
			const cols = getColumnsCount();
			if (selectedIndex >= cols) {
				navigate('up');
				return true;
			}
			return false; // Let system navigate to search area
		},
		down() {
			const cols = getColumnsCount();
			if (selectedIndex + cols < items.length) {
				navigate('down');
				return true;
			}
			return false;
		},
		left() {
			const cols = getColumnsCount();
			if (selectedIndex % cols !== 0) {
				navigate('left');
				return true;
			}
			return false;
		},
		right() {
			const cols = getColumnsCount();
			if (selectedIndex % cols !== cols - 1 && selectedIndex < items.length - 1) {
				navigate('right');
				return true;
			}
			return false;
		},
		confirmDown() {
			isAPressed = true;
		},
		confirmUp() {
			isAPressed = false;
			openItem();
		},
		confirmCancel() {
			isAPressed = false;
		},
		back() { onBack?.(); },
	};

	onMount(() => {
		const unregisterSearch = useArea(
			searchAreaID,
			{
				up() { return false; },
				down() { return false; },
				confirmUp() { searchBar?.toggleFocus(); },
				back() { onBack?.(); },
			},
			searchPosition
		);

		unregisterList = useArea(listAreaID, areaHandlers, listPosition);
		activateArea(listAreaID);
		return () => {
			if (unregisterList) unregisterList();
			unregisterSearch();
		};
	});
</script>

<style>
	.items {
		display: grid;
		gap: 2vh;
		padding: 2vh;
		width: 100%;
		box-sizing: border-box;
		grid-template-columns: 1fr;
	}

	@media (min-width: 768px) {
		.items {
			grid-template-columns: repeat(3, 1fr);
		}
	}

	@media (min-width: 1000px) {
		.items {
			grid-template-columns: repeat(4, 1fr);
		}
	}

	@media (min-width: 1200px) {
		.items {
			grid-template-columns: repeat(5, 1fr);
		}
	}

	@media (min-width: 1400px) {
		.items {
			grid-template-columns: repeat(6, 1fr);
		}
	}
</style>

{#if selectedItem}
	<Product areaID={listAreaID} category={title} itemTitle={selectedItem.title} itemId={selectedItem.id} onBack={closeDetail} />
{:else}
	<SearchBar bind:this={searchBar} selected={searchSelected} />
	<div class="items">
		{#each items as item, index (item.id)}
			<div bind:this={itemElements[index]} onclick={() => handleProductClick(index)} onmouseenter={() => { activateArea(listAreaID); selectedIndex = index; }} onkeydown={e => e.key === 'Enter' && handleProductClick(index)} role="button" tabindex="-1">
				<ProductsItem title={item.title} image="https://picsum.photos/seed/{item.id}/400/225" isGamepadHovered={active && index === selectedIndex} isAPressed={active && isAPressed && index === selectedIndex} />
			</div>
		{/each}
	</div>
{/if}
