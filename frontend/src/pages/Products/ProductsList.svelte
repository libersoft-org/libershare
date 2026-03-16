<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { createNavArea, type NavPos, type NavItem } from '../../scripts/navArea.svelte.ts';
	import { activateArea } from '../../scripts/areas.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { getGridColumnsCount } from '../../scripts/products.ts';
	import ProductsItem from './ProductsItem.svelte';
	import Product from '../Product/Product.svelte';
	interface Props {
		areaID: string;
		position: Position;
		title: string;
		items: { id: number; title: string }[];
		onBack?: (() => void) | undefined;
	}
	let { areaID, position, title, items, onBack }: Props = $props();
	let selectedItem = $state<{ id: number; title: string } | null>(null);
	let itemElements: HTMLElement[] = $state([]);
	let removeBackHandler: (() => void) | null = null;

	function getItemPos(index: number): NavPos {
		const cols = getGridColumnsCount(itemElements);
		return [index % cols, Math.floor(index / cols)];
	}

	function openItem(index: number): void {
		selectedItem = items[index]!;
		pushBreadcrumb(items[index]!.title);
		navHandle.pause();
		removeBackHandler = pushBackHandler(closeDetail);
	}

	async function closeDetail(): Promise<void> {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		selectedItem = null;
		popBreadcrumb();
		await tick();
		navHandle.resume();
		activateArea(areaID);
	}

	const navHandle = createNavArea(() => ({
		areaID,
		position,
		onBack,
		activate: true,
	}));

	onMount(() => {
		const cleanups = items.map((_, idx) => {
			const item: NavItem = {
				get pos() {
					return getItemPos(idx);
				},
				get el() {
					return itemElements[idx];
				},
				onConfirm: () => openItem(idx),
			};
			return navHandle.controller.register(item);
		});
		return () => cleanups.forEach(c => c());
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
	<Product {areaID} category={title} itemTitle={selectedItem.title} itemID={selectedItem.id} onBack={closeDetail} />
{:else}
	<div class="items">
		{#each items as item, index (item.id)}
			<ProductsItem bind:el={itemElements[index]} title={item.title} image="https://picsum.photos/seed/{item.id}/400/225" isGamepadHovered={navHandle.controller.isSelected(getItemPos(index))} isAPressed={navHandle.controller.isPressed(getItemPos(index))} />
		{/each}
	</div>
{/if}
