<script lang="ts">
	import { onMount } from 'svelte';
	import { registerScene, activateScene } from '../../scripts/input.ts';
	import { focusArea, focusHeader } from '../../scripts/navigation.ts';
	import ButtonNormal from '../Buttons/ButtonNormal.svelte';

	interface Props {
		items: Array<{ id: string; label: string }>;
		orientation?: 'horizontal' | 'vertical';
		sceneId?: string;
		selectedId?: string;
		onselect?: (id: string) => void;
		onback?: () => void;
	}
	let { items, orientation = 'horizontal', sceneId = 'menu', selectedId, onselect, onback }: Props = $props();
	let selectedIndex = $state(
		selectedId
			? Math.max(
					0,
					items.findIndex(i => i.id === selectedId)
				)
			: 0
	);
	let isAPressed = $state(false);
	let active = $derived($focusArea === 'content');

	function navigate(direction: 'prev' | 'next'): void {
		if (direction === 'prev') selectedIndex = selectedIndex === 0 ? items.length - 1 : selectedIndex - 1;
		else selectedIndex = selectedIndex === items.length - 1 ? 0 : selectedIndex + 1;
	}

	function handleUp(): void {
		if (orientation === 'vertical' && selectedIndex === 0) focusHeader();
		else if (orientation === 'vertical') navigate('prev');
		else focusHeader();
	}

	function selectItem(): void {
		if (items[selectedIndex]) onselect?.(items[selectedIndex].id);
	}

	onMount(() => {
		const handlers = orientation === 'horizontal' ? { left: () => navigate('prev'), right: () => navigate('next'), up: handleUp } : { up: handleUp, down: () => navigate('next') };
		const unregister = registerScene(sceneId, {
			...handlers,
			confirmDown: () => {
				isAPressed = true;
			},
			confirmUp: () => {
				isAPressed = false;
				selectItem();
			},
			confirmCancel: () => {
				isAPressed = false;
			},
			back: () => onback?.(),
		});
		activateScene(sceneId);
		return unregister;
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
		transition: all 0.2s linear;
	}

	.items.horizontal {
		flex-direction: row;
		padding: 0 calc(50vw - 100px);
	}

	.items.vertical {
		flex-direction: column;
		margin: 0 auto;
		gap: 1vw;
	}

	.items.vertical :global(.menu-button) {
		width: 100%;
	}
</style>

{#if orientation === 'horizontal'}
	<div class="items-wrapper">
		<div class="items horizontal" style="transform: translateX(calc({selectedIndex} * -232px))">
			{#each items as item, index (item.id)}
				<ButtonNormal label={item.label} selected={active && index === selectedIndex} pressed={isAPressed} />
			{/each}
		</div>
	</div>
{:else}
	<div class="items vertical">
		{#each items as item, index (item.id)}
			<ButtonNormal label={item.label} selected={active && index === selectedIndex} pressed={isAPressed} />
		{/each}
	</div>
{/if}
