<script lang="ts">
	import { onMount } from 'svelte';
	import { useInput } from '../scripts/input';
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
		min-height: 100vh;
		padding: 2rem;
		box-sizing: border-box;
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

	.exit-menu-item {
		padding: 1.2rem 2rem;
		background: rgba(255, 255, 255, 0.15);
		border: 2px solid rgba(255, 255, 255, 0.3);
		border-radius: 12px;
		font-size: 1.4rem;
		color: #fff;
		text-align: center;
		transition: all 0.2s ease;
		backdrop-filter: blur(10px);
		opacity: 0.7;
	}

	.exit-menu-item.selected {
		background: rgba(255, 255, 255, 0.3);
		border-color: #fff;
		border-width: 3px;
		box-shadow: 0 0 20px rgba(255, 255, 255, 0.4);
		font-weight: bold;
		opacity: 1;
		transform: scale(1.02);
	}

	.exit-menu-item.selected.pressed {
		transform: scale(0.98);
		background: rgba(255, 255, 255, 0.4);
	}
</style>

<div class="exit-menu-container">
	<h1 class="exit-menu-title">Exit</h1>
	<div class="exit-menu-items">
		{#each items as item, index (item.id)}
			<div class="exit-menu-item" class:selected={index === selectedIndex} class:pressed={index === selectedIndex && isAPressed}>
				{item.label}
			</div>
		{/each}
	</div>
</div>
