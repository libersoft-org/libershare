<script lang="ts">
	import { onMount } from 'svelte';
	import { useInput } from '../scripts/input';
	import MenuButton from './MenuButton.svelte';

	interface Props {
		items: Array<{ id: string; label: string }>;
		orientation?: 'horizontal' | 'vertical';
		scopeId?: string;
		onselect?: (id: string) => void;
		onback?: () => void;
	}
	let { items, orientation = 'horizontal', scopeId = 'menu', onselect, onback }: Props = $props();
	let selectedIndex = $state(0);
	let isAPressed = $state(false);

	// Calculate offset for horizontal menu - each item + gap = approximately 280px
	let offset = $derived(selectedIndex * -280);

	function navigate(direction: 'prev' | 'next'): void {
		if (direction === 'prev') {
			selectedIndex = selectedIndex === 0 ? items.length - 1 : selectedIndex - 1;
		} else {
			selectedIndex = selectedIndex === items.length - 1 ? 0 : selectedIndex + 1;
		}
	}

	function selectItem(): void {
		if (items[selectedIndex]) {
			onselect?.(items[selectedIndex].id);
		}
	}

	onMount(() => {
		const handlers = orientation === 'horizontal'
			? { left: () => navigate('prev'), right: () => navigate('next') }
			: { up: () => navigate('prev'), down: () => navigate('next') };

		return useInput(scopeId, {
			...handlers,
			confirmDown: () => {
				isAPressed = true;
				selectItem();
			},
			confirmUp: () => {
				isAPressed = false;
			},
			back: () => onback?.(),
		});
	});
</script>

<style>
	.items-wrapper {
		width: 100%;
		overflow: hidden;
		padding: 2rem 0;
	}

	.items {
		display: flex;
		align-items: center;
		gap: 2rem;
		transition: transform 0.3s ease-out;
	}

	.items.horizontal {
		flex-direction: row;
		padding: 0 50vw;
	}

	.items.vertical {
		flex-direction: column;
		max-width: 400px;
		margin: 0 auto;
		gap: 1vw;
	}
</style>

{#if orientation === 'horizontal'}
	<div class="items-wrapper">
		<div class="items horizontal" style="transform: translateX({offset}px)">
			{#each items as item, index (item.id)}
				<MenuButton label={item.label} selected={index === selectedIndex} pressed={isAPressed} />
			{/each}
		</div>
	</div>
{:else}
	<div class="items vertical">
		{#each items as item, index (item.id)}
			<MenuButton label={item.label} selected={index === selectedIndex} pressed={isAPressed} />
		{/each}
	</div>
{/if}
