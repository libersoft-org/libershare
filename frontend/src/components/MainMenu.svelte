<script lang="ts">
	import { onMount } from 'svelte';
	import { getGamepadManager } from '../scripts/gamepad';
	
	interface Props {
		title?: string;
		items: Array<{ id: string; label: string }>;
		onselect?: (id: string) => void;
		onback?: () => void;
	}
	let { title = 'LiberShare', items, onselect, onback }: Props = $props();
	const gamepad = getGamepadManager();
	let selectedIndex = $state(0);
	let isAPressed = $state(false);
	
	// Výpočet posunu pruhu - každá položka + gap = přibližně 280px
	let offset = $derived(selectedIndex * -280);
	
	// Nekonečná navigace (wrap around)
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
		gamepad.on('left', () => navigate('left'));
		gamepad.on('right', () => navigate('right'));
		gamepad.on('aDown', () => { 
			isAPressed = true;
			selectItem();
		});
		gamepad.on('aUp', () => { isAPressed = false; });
		gamepad.on('bDown', () => onback?.());
		gamepad.start();
		
		// Podpora klávesnice
		const handleKeyboard = (e: KeyboardEvent) => {
			switch(e.key) {
				case 'ArrowLeft':
					navigate('left');
					break;
				case 'ArrowRight':
					navigate('right');
					break;
				case 'Enter':
					isAPressed = true;
					selectItem();
					setTimeout(() => { isAPressed = false; }, 100);
					break;
				case 'Escape':
					onback?.();
					break;
			}
		};
		
		window.addEventListener('keydown', handleKeyboard);
		
		return () => {
			window.removeEventListener('keydown', handleKeyboard);
			gamepad.off('left');
			gamepad.off('right');
			gamepad.off('aDown');
			gamepad.off('aUp');
			gamepad.off('bDown');
		};
	});
</script>

<style>
	.menu-container {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-height: 100vh;
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
	
	.menu-item {
		flex-shrink: 0;
		padding: 1.5rem 3rem;
		background: rgba(255, 255, 255, 0.15);
		border: 2px solid rgba(255, 255, 255, 0.3);
		border-radius: 12px;
		font-size: 1.6rem;
		color: #fff;
		text-align: center;
		white-space: nowrap;
		transition: all 0.3s ease;
		backdrop-filter: blur(10px);
		opacity: 0.6;
	}
	
	.menu-item.center {
		background: rgba(255, 255, 255, 0.3);
		border-color: #fff;
		border-width: 3px;
		box-shadow: 0 0 30px rgba(255, 255, 255, 0.5);
		font-weight: bold;
		opacity: 1;
		transform: scale(1.1);
	}
	
	.menu-item.center.pressed {
		transform: scale(1.05);
		background: rgba(255, 255, 255, 0.4);
	}
</style>

<div class="menu-container">
	<h1 class="menu-title">{title}</h1>
	<div class="menu-items-wrapper">
		<div class="menu-items" style="transform: translateX({offset}px)">
			{#each items as item, index (item.id)}
				<div 
					class="menu-item"
					class:center={index === selectedIndex}
					class:pressed={index === selectedIndex && isAPressed}
				>
					{item.label}
				</div>
			{/each}
		</div>
	</div>
</div>
