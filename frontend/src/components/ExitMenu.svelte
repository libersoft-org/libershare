<script lang="ts">
	import { onMount } from 'svelte';
	import { useInput } from '../scripts/input';
	import MenuButton from './MenuButton.svelte';
	interface Props {
		onselect?: (id: string) => void;
		onback?: () => void;
	}
	let { onselect, onback }: Props = $props();
	const items = [
		{ id: 'restart', label: 'Restart' },
		{ id: 'shutdown', label: 'Shutdown' },
		{ id: 'exit', label: 'Exit Application' },
	];
	let selectedIndex = $state(0);
	let isAPressed = $state(false);

	function navigate(direction: string): void {
		switch (direction) {
			case 'up':
				selectedIndex = selectedIndex === 0 ? items.length - 1 : selectedIndex - 1;
				break;
			case 'down':
				selectedIndex = selectedIndex === items.length - 1 ? 0 : selectedIndex + 1;
				break;
		}
	}

	function selectItem(): void {
		if (items[selectedIndex]) onselect?.(items[selectedIndex].id);
	}

	onMount(() => {
		return useInput('exit-menu', {
			up: () => navigate('up'),
			down: () => navigate('down'),
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
	.exit-menu-container {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100vh;
		padding: 2rem;
		box-sizing: border-box;
		overflow: hidden;
	}

	.exit-menu-title {
		font-size: 2.5rem;
		font-weight: bold;
		margin-bottom: 3rem;
		color: #fff;
		text-align: center;
		text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.3);
	}

	.exit-menu-items {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		width: 100%;
		max-width: 400px;
	}
</style>

<div class="exit-menu-container">
	<h1 class="exit-menu-title">Exit</h1>
	<div class="exit-menu-items">
		{#each items as item, index (item.id)}
			<MenuButton 
				label={item.label}
				selected={index === selectedIndex}
				pressed={isAPressed}
			/>
		{/each}
	</div>
</div>
