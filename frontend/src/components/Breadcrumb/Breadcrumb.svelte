<script lang="ts">
	import { onMount } from 'svelte';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { type BreadcrumbItem } from '../../scripts/breadcrumb.ts';
	import Icon from '../Icon/Icon.svelte';
	interface Props {
		areaID: string;
		items: BreadcrumbItem[];
		position: Position;
		onSelect?: ((item: BreadcrumbItem, index: number) => void) | undefined;
		onBack?: (() => void) | undefined;
		onDown?: (() => string | false) | undefined; // Return area ID to navigate to, or false for default behavior
	}
	let { areaID, items, position, onSelect, onBack, onDown }: Props = $props();
	let selectedIndex = $state(0);
	let active = $derived($activeArea === areaID);
	let maxIndex = $derived(items.length - 2); // Last item (current) is not selectable
	const areaHandlers = {
		left() {
			if (selectedIndex > 0) {
				selectedIndex--;
				return true;
			}
			return false;
		},
		right() {
			if (selectedIndex < maxIndex) {
				selectedIndex++;
				return true;
			}
			return false;
		},
		up() { return false; },
		down() {
			if (onDown) {
				const target = onDown();
				if (target) {
					activateArea(target);
					return true;
				}
			}
			return false;
		},
		confirmDown() {},
		confirmUp() {
			const item = items[selectedIndex];
			if (item && selectedIndex < items.length - 1) onSelect?.(item, selectedIndex);
		},
		confirmCancel() {},
		back() { onBack?.(); },
		onActivate() { selectedIndex = Math.max(0, items.length - 2); },
	};

	function handleItemClick(index: number) {
		if (index >= items.length - 1) return; // Current item not selectable
		activateArea(areaID);
		selectedIndex = index;
		const item = items[index];
		if (item) onSelect?.(item, index);
	}

	onMount(() => {
		return useArea(areaID, areaHandlers, position);
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
		padding: 0.5vh;
		border-radius: 1vh;
	}

	.item.current {
		color: var(--primary-foreground);
		font-weight: bold;
	}

	.item.selected {
		background-color: var(--primary-foreground);
		color: var(--secondary-background);
	}

	.item.clickable:hover:not(.selected) {
		color: var(--secondary-foreground);
		background-color: var(--secondary-softer-background);
	}
</style>

<div class="breadcrumb">
	{#each items as item, index (item.id)}
		{#if index > 0}
			<Icon img="/img/caret-right.svg" size="2vh" padding="0" colorVariable="--disabled-foreground" />
		{/if}
		{@const isSelected = active && selectedIndex === index}
		<div class="item" class:current={index === items.length - 1} class:selected={isSelected} class:clickable={index < items.length - 1} onclick={() => handleItemClick(index)} role={index < items.length - 1 ? 'button' : undefined} tabindex="-1">
			{#if item.icon}
				<Icon img={item.icon} size="2vh" padding="0" colorVariable={isSelected ? '--primary-background' : '--disabled-foreground'} />
			{:else}
				{item.name}
			{/if}
		</div>
	{/each}
</div>
