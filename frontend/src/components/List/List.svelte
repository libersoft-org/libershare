<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { registerArea, activateArea, navigateLeft, navigateRight } from '../../scripts/areas.ts';
	import { focusArea, focusHeader, pushBreadcrumb, popBreadcrumb, scrollContentToTop } from '../../scripts/navigation.ts';
	import ListItem from './ListItem.svelte';
	import Product from '../Product/Product.svelte';
	const AREA_ID = 'list';
	interface Props {
		title?: string;
		category?: string;
		onBack?: () => void;
	}
	let { title = 'Items', category = '', onBack }: Props = $props();
	let active = $derived($focusArea === 'content');
	// Some test data
	const items = Array.from({ length: 200 }, (_, i) => ({
		id: i + 1,
		title: 'Item ' + (i + 1),
	}));
	let selectedIndex = $state(0);
	let isAPressed = $state(false);
	let itemElements: HTMLElement[] = $state([]);
	let selectedItem = $state<{ id: number; title: string } | null>(null);

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
	}

	async function closeDetail(): Promise<void> {
		selectedItem = null;
		popBreadcrumb();
		await tick();
		scrollToSelectedItem(true);
		activateArea(AREA_ID);
	}

	onMount(() => {
		const unregister = registerArea(AREA_ID, { x: 1, y: 1 }, {
			up: () => {
				const cols = getColumnsCount();
				if (selectedIndex < cols) focusHeader();
				else navigate('up');
			},
			down: () => navigate('down'),
			left: () => {
				const cols = getColumnsCount();
				if (selectedIndex % cols === 0) navigateLeft();
				else navigate('left');
			},
			right: () => {
				const cols = getColumnsCount();
				if (selectedIndex % cols === cols - 1 || selectedIndex === items.length - 1) navigateRight();
				else navigate('right');
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
		});
		activateArea(AREA_ID);
		return unregister;
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
	<Product category={title} itemTitle={selectedItem.title} itemId={selectedItem.id} onBack={closeDetail} />
{:else}
	<div class="items">
		{#each items as item, index (item.id)}
			<div bind:this={itemElements[index]}>
				<ListItem title={item.title} image="https://picsum.photos/seed/{item.id}/400/225" isGamepadHovered={active && index === selectedIndex} isAPressed={active && isAPressed && index === selectedIndex} />
			</div>
		{/each}
	</div>
{/if}
