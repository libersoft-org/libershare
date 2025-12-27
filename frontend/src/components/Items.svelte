<script lang="ts">
	import ItemsItem from './ItemsItem.svelte';
	import { onMount } from 'svelte';
	import { useInput } from '../scripts/input';
	interface Props {
		title?: string;
		onback?: () => void;
	}
	let { title = 'Items', onback }: Props = $props();
	// Some test data
	const items = Array.from({ length: 200 }, (_, i) => ({
		id: i + 1,
		title: 'Item ' + (i + 1),
	}));
	let selectedIndex = $state(0);
	let isAPressed = $state(false);
	let itemElements: HTMLElement[] = $state([]);

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

	function scrollToSelectedItem(): void {
		const selectedElement = itemElements[selectedIndex];
		if (selectedElement) {
			selectedElement.scrollIntoView({
				behavior: 'smooth',
				block: 'center',
				inline: 'center',
			});
		}
	}

	onMount(() => {
		return useInput('items', {
			up: () => navigate('up'),
			down: () => navigate('down'),
			left: () => navigate('left'),
			right: () => navigate('right'),
			confirmDown: () => {
				isAPressed = true;
			},
			confirmUp: () => {
				isAPressed = false;
			},
			back: () => onback?.(),
		});
	});
</script>

<style>
	.items {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
		gap: 1vw;
		padding: 1vw;
		width: 100%;
		box-sizing: border-box;
		justify-content: center;
		place-items: stretch;
	}

	.items :global(.item) {
		max-width: 400px;
		width: 100%;
		margin: 0 auto;
	}
</style>

<div class="items">
	{#each items as item, index (item.id)}
		<div bind:this={itemElements[index]}>
			<ItemsItem title={item.title} isGamepadHovered={index === selectedIndex} isAPressed={isAPressed && index === selectedIndex} />
		</div>
	{/each}
</div>
