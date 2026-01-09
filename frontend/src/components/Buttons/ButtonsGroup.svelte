<script lang="ts" module>
	export type ButtonsGroupContext = {
		register: (button: { onConfirm?: () => void }) => { index: number; unregister: () => void };
		isSelected: (index: number) => boolean;
		isPressed: (index: number) => boolean;
	};
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { setContext, onMount } from 'svelte';
	import { registerArea, activateArea, navigateUp, navigateLeft, navigateRight, activeArea, type AreaPosition } from '../../scripts/areas.ts';

	interface Props {
		children: Snippet;
		areaID: string;
		areaPosition?: AreaPosition;
		initialIndex?: number;
		orientation?: 'horizontal' | 'vertical';
		onBack?: () => void;
	}

	let { children, areaID, areaPosition = { x: 1, y: 1 }, initialIndex = 0, orientation = 'vertical', onBack }: Props = $props();
	let selectedIndex = $state(initialIndex);
	let isAPressed = $state(false);
	let buttons: { onConfirm?: () => void }[] = [];
	let active = $derived($activeArea === areaID);
	let itemsElement: HTMLElement;
	let translateX = $state(0);

	setContext<ButtonsGroupContext>('buttonsGroup', {
		register: button => {
			const index = buttons.length;
			buttons.push(button);
			return {
				index,
				unregister: () => {
					buttons = buttons.filter((_, i) => i !== index);
				},
			};
		},
		isSelected: index => active && selectedIndex === index,
		isPressed: index => active && selectedIndex === index && isAPressed,
	});

	function updateTranslateX() {
		if (!itemsElement || orientation !== 'horizontal') return;
		const children = itemsElement.children;
		if (children.length === 0) return;

		let offset = 0;
		for (let i = 0; i < selectedIndex; i++) {
			const child = children[i] as HTMLElement;
			offset += child.offsetWidth;
		}
		// Add gaps (converted to pixels)
		const gap = parseFloat(getComputedStyle(itemsElement).gap) || 0;
		offset += selectedIndex * gap;
		// Add half of selected button width
		const selectedChild = children[selectedIndex] as HTMLElement;
		if (selectedChild) {
			offset += selectedChild.offsetWidth / 2;
		}
		translateX = -offset;
	}

	$effect(() => {
		selectedIndex;
		updateTranslateX();
	});

	function navigatePrev() {
		if (selectedIndex > 0) selectedIndex--;
	}

	function navigatePrevOrExit() {
		if (selectedIndex > 0) selectedIndex--;
		else navigateUp();
	}

	function navigateNextItem() {
		if (selectedIndex < buttons.length - 1) selectedIndex++;
	}

	function navigateNextOrRight() {
		if (selectedIndex < buttons.length - 1) selectedIndex++;
		else navigateRight();
	}

	function navigatePrevOrLeft() {
		if (selectedIndex > 0) selectedIndex--;
		else navigateLeft();
	}

	onMount(() => {
		const handlers =
			orientation === 'horizontal'
				? { left: navigatePrevOrLeft, right: navigateNextOrRight, up: navigateUp }
				: { up: navigatePrevOrExit, down: navigateNextItem, left: navigateLeft, right: navigateRight };
		const unregister = registerArea(areaID, areaPosition, {
			...handlers,
			confirmDown: () => {
				isAPressed = true;
			},
			confirmUp: () => {
				isAPressed = false;
				buttons[selectedIndex]?.onConfirm?.();
			},
			confirmCancel: () => {
				isAPressed = false;
			},
			back: () => onBack?.(),
		});
		activateArea(areaID);
		updateTranslateX();
		return unregister;
	});
</script>

<style>
	.items-wrapper {
		width: 100%;
		overflow: hidden;
		padding: 2vh 0;
	}

	.items {
		display: flex;
		align-items: center;
		gap: 3vh;
		transition: all 0.2s linear;
	}

	.items.horizontal {
		flex-direction: row;
		padding: 0 50%;
	}

	.items.vertical {
		flex-direction: column;
		gap: 2vh;
	}

	.items.vertical :global(.menu-button) {
		width: 100%;
	}
</style>

{#if orientation === 'horizontal'}
	<div class="items-wrapper">
		<div class="items horizontal" bind:this={itemsElement} style="transform: translateX({translateX}px)">
			{@render children()}
		</div>
	</div>
{:else}
	<div class="items-wrapper">
		<div class="items vertical">
			{@render children()}
		</div>
	</div>
{/if}
