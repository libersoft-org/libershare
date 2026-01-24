<script lang="ts">
	import { onMount } from 'svelte';
	import { useArea, activeArea, setAreaPosition, removeArea } from '../../scripts/areas.ts';
	export interface BreadcrumbItem {
		id: string;
		name: string;
		icon?: string;
	}
	interface Props {
		areaID: string;
		items: BreadcrumbItem[];
		position?: { x: number; y: number };
		onSelect?: (item: BreadcrumbItem, index: number) => void;
		onUp?: () => void;
		onDown?: () => void;
		onBack?: () => void;
	}
	let { areaID, items, position, onSelect, onUp, onDown, onBack }: Props = $props();
	let selectedIndex = $state(0);
	let active = $derived($activeArea === areaID);
	let maxIndex = $derived(items.length - 2); // Last item (current) is not selectable

	const areaHandlers = {
		left: () => {
			if (selectedIndex > 0) {
				selectedIndex--;
				return true;
			}
			return false;
		},
		right: () => {
			if (selectedIndex < maxIndex) {
				selectedIndex++;
				return true;
			}
			return false;
		},
		up: () => {
			if (onUp) {
				onUp();
				return true;
			}
			return false;
		},
		down: () => {
			if (onDown) {
				onDown();
				return true;
			}
			return false;
		},
		confirmDown: () => {},
		confirmUp: () => {
			const item = items[selectedIndex];
			if (item && selectedIndex < items.length - 1) {
				onSelect?.(item, selectedIndex);
			}
		},
		confirmCancel: () => {},
		back: () => onBack?.(),
		onActivate: () => {
			selectedIndex = Math.max(0, items.length - 2);
		},
	};

	onMount(() => {
		if (position) setAreaPosition(areaID, position);
		const unregister = useArea(areaID, areaHandlers);
		return () => {
			unregister();
			if (position) removeArea(areaID);
		};
	});
</script>

<style>
	.breadcrumb {
		flex-wrap: wrap;
		width: 100%;
		padding: 1vh 1.5vh;
		background-color: var(--secondary-soft-background);
		font-size: 2vh;
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: 0.5vh;
		border-bottom: 0.2vh solid var(--secondary-softer-background);
	}

	.item {
		color: var(--disabled-foreground);
		padding: 0.2vh 0.6vh;
		border-radius: 0.5vh;
		cursor: pointer;
	}

	.item:hover:not(.current) {
		background-color: var(--secondary-soft-background);
	}

	.item.current {
		color: var(--primary-foreground);
		font-weight: bold;
		cursor: default;
	}

	.item.selected {
		background-color: var(--primary-foreground);
		color: var(--secondary-background);
	}

	.separator {
		height: 1.5vh;
		width: 1.5vh;
	}

	.item-icon {
		height: 1.8vh;
		width: 1.8vh;
		vertical-align: middle;
	}
</style>

<div class="breadcrumb">
	{#each items as item, index (item.id)}
		{#if index > 0}
			<img class="separator" src="/img/caret-right.svg" alt=">" />
		{/if}
		<span class="item" class:current={index === items.length - 1} class:selected={active && selectedIndex === index} onclick={() => index < items.length - 1 && onSelect?.(item, index)}>
			{#if item.icon}
				<img class="item-icon" src={item.icon} alt="" />
			{:else}
				{item.name}
			{/if}
		</span>
	{/each}
</div>
