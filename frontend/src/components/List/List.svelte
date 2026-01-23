<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { useArea, setAreaPosition, removeArea, activateArea, activeArea } from '../../scripts/areas.ts';
	import { pushBreadcrumb, popBreadcrumb, scrollContentToTop } from '../../scripts/navigation.ts';
	import SearchBar from '../Search/SearchBar.svelte';
	import ListItem from './ListItem.svelte';
	import Product from '../Product/Product.svelte';
	interface Props {
		areaID: string;
		title?: string;
		category?: string;
		onBack?: () => void;
	}
	let { areaID, title = 'Items', onBack }: Props = $props();
	const searchAreaID = `${areaID}-search`;
	const listAreaID = `${areaID}-list`;
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
	let unregisterList: (() => void) | null = null; // Handlers will be set in onMount
	let searchBar: SearchBar | undefined = $state();

	// Calculate columns by comparing Y positions of items
	function getColumnsCount(): number {
		if (itemElements.length < 2) return 1;
		const firstItemY = itemElements[0].offsetTop;
		let cols = 1;
		// Count how many items are on the first row (same Y position)
		for (let i = 1; i < itemElements.length; i++) {
			if (itemElements[i].offsetTop === firstItemY) cols++;
			else break;
		}
		return cols;
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
		const selectedElement = itemElements[selectedIndex];
		if (selectedElement) {
			selectedElement.scrollIntoView({
				behavior: instant ? 'instant' : 'smooth',
				block: 'center',
				inline: 'center',
			});
		}
	}

	function openItem(): void {
		selectedItem = items[selectedIndex];
		pushBreadcrumb(items[selectedIndex].title);
		scrollContentToTop();
		isAPressed = false;
		// Unregister list area when showing product detail
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
		// Re-register list area when returning from product detail
		unregisterList = useArea(listAreaID, areaHandlers);
		activateArea(listAreaID);
	}

	const areaHandlers = {
		up: () => {
			const cols = getColumnsCount();
			if (selectedIndex >= cols) {
				navigate('up');
				return true;
			}
			// Navigate to search bar when at top row
			activateArea(searchAreaID);
			return true;
		},
		down: () => {
			const cols = getColumnsCount();
			if (selectedIndex + cols < items.length) {
				navigate('down');
				return true;
			}
			return false;
		},
		left: () => {
			const cols = getColumnsCount();
			if (selectedIndex % cols !== 0) {
				navigate('left');
				return true;
			}
			return false;
		},
		right: () => {
			const cols = getColumnsCount();
			if (selectedIndex % cols !== cols - 1 && selectedIndex < items.length - 1) {
				navigate('right');
				return true;
			}
			return false;
		},
		confirmDown: () => {
			isAPressed = true;
		},
		confirmUp: () => {
			isAPressed = false;
			openItem();
		},
		confirmCancel: () => {
			isAPressed = false;
		},
		back: () => onBack?.(),
	};

	onMount(() => {
		// Position search between breadcrumb (y=1) and list (y=2)
		setAreaPosition(searchAreaID, { x: 0, y: 1.5 });
		setAreaPosition(listAreaID, { x: 0, y: 2 });
		// Register search area handlers
		const unregisterSearch = useArea(searchAreaID, {
			up: () => {
				activateArea('breadcrumb');
				return true;
			},
			down: () => {
				activateArea(listAreaID);
				return true;
			},
			confirmUp: () => {
				searchBar?.toggleFocus();
			},
			back: () => onBack?.(),
		});
		unregisterList = useArea(listAreaID, areaHandlers);
		activateArea(listAreaID);
		return () => {
			if (unregisterList) unregisterList();
			unregisterSearch();
			removeArea(searchAreaID);
			removeArea(listAreaID);
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
			<div bind:this={itemElements[index]}>
				<ListItem title={item.title} image="https://picsum.photos/seed/{item.id}/400/225" isGamepadHovered={active && index === selectedIndex} isAPressed={active && isAPressed && index === selectedIndex} />
			</div>
		{/each}
	</div>
{/if}
