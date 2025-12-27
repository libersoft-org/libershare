<script lang="ts">
	import { onMount } from 'svelte';
	import { useInput } from '../scripts/input';
	import MenuButton from './MenuButton.svelte';
	
	interface Props {
		title?: string;
		items: Array<{ id: string; label: string }>;
		onselect?: (id: string) => void;
		onback?: () => void;
	}
	let { title = 'LiberShare', items, onselect, onback }: Props = $props();
	let selectedIndex = $state(0);
	let isAPressed = $state(false);
	
	// Calculate offset - each item + gap = approximately 280px
	let offset = $derived(selectedIndex * -280);
	
	// Infinite navigation (wrap around)
	function navigate(direction: string): void {
		switch (direction) {
			case 'left':
				selectedIndex = selectedIndex === 0 ? items.length - 1 : selectedIndex - 1;
				break;
			case 'right':
				selectedIndex = selectedIndex === items.length - 1 ? 0 : selectedIndex + 1;
				break;
		}
	}
	
	function selectItem(): void {
		if (items[selectedIndex]) {
			onselect?.(items[selectedIndex].id);
		}
	}
	
	onMount(() => {
		return useInput('main-menu', {
			left: () => navigate('left'),
			right: () => navigate('right'),
			confirmDown: () => {
				isAPressed = true;
				selectItem();
			},
			confirmUp: () => { isAPressed = false; },
			back: () => onback?.()
		});
	});
</script>

<style>
	.menu-container {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100vh;
		padding: 0;
		box-sizing: border-box;
		overflow: hidden;
	}
	
	.menu-title {
		font-size: 3rem;
		font-weight: bold;
		margin-bottom: 4rem;
		color: #fff;
		text-align: center;
		text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.3);
	}
	
	.menu-items-wrapper {
		width: 100%;
		overflow: hidden;
		padding: 2rem 0;
	}
	
	.menu-items {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 2rem;
		transition: transform 0.3s ease-out;
		padding: 0 50vw;
	}
</style>

<div class="menu-container">
	<h1 class="menu-title">{title}</h1>
	<div class="menu-items-wrapper">
		<div class="menu-items" style="transform: translateX({offset}px)">
			{#each items as item, index (item.id)}
				<MenuButton 
					label={item.label}
					selected={index === selectedIndex}
					pressed={isAPressed}
				/>
			{/each}
		</div>
	</div>
</div>
