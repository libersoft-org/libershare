<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { useArea, activeArea } from '../../scripts/areas.ts';
	interface Props {
		areaID: string;
		items: string[];
		onBack?: () => void;
	}
	let { areaID, items, onBack }: Props = $props();
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
		up: () => false,
		down: () => false,
		confirmDown: () => {},
		confirmUp: async () => {
			// Navigate to the selected breadcrumb level
			const stepsBack = items.length - 1 - selectedIndex;
			for (let i = 0; i < stepsBack; i++) {
				onBack?.();
				await tick();
			}
		},
		confirmCancel: () => {},
		back: () => onBack?.(),
		onActivate: () => {
			selectedIndex = Math.max(0, items.length - 2);
		},
	};

	onMount(() => {
		const unregister = useArea(areaID, areaHandlers);
		return unregister;
	});
</script>

<style>
	.breadcrumb {
		flex-wrap: wrap;
		width: 100%;
		padding: 1vh;
		background-color: var(--secondary-soft-background);
		font-size: 2.5vh;
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: 1vh;
		border-bottom: 0.2vh solid var(--secondary-softer-background);
	}

	.item {
		color: var(--disabled-foreground);
		padding: 0.2vh 0.8vh;
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

	.separator {
		color: var(--disabled-foreground);
	}
</style>

<div class="breadcrumb">
	{#each items as item, index (index)}
		{#if index > 0}
			<span class="separator">&gt;</span>
		{/if}
		<span class="item" class:current={index === items.length - 1} class:selected={active && selectedIndex === index}>{item}</span>
	{/each}
</div>
