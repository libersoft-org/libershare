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
	import { useArea, activateArea, activeArea } from '../../scripts/areas.ts';
	interface Props {
		children: Snippet;
		areaID: string;
		initialIndex?: number;
		orientation?: 'horizontal' | 'vertical';
		onBack?: () => void;
		onUp?: () => void;
	}
	let { children, areaID, initialIndex = 0, orientation = 'vertical', onBack, onUp }: Props = $props();
	let selectedIndex = $state(initialIndex);
	let isAPressed = $state(false);
	let buttons: { onConfirm?: () => void }[] = [];
	let active = $derived($activeArea === areaID);
	let itemsElement = $state<HTMLElement | null>(null);
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
		if (selectedChild) offset += selectedChild.offsetWidth / 2;
		translateX = -offset;
	}

	onMount(() => {
		const handlers =
			orientation === 'horizontal'
				? {
						up: () => {
							if (onUp) {
								onUp();
								return true;
							}
							return false;
						},
						down: () => false, // Allow navigation to area below
						left: () => {
							if (selectedIndex > 0) {
								selectedIndex--;
								updateTranslateX();
								return true;
							}
							return false;
						},
						right: () => {
							if (selectedIndex < buttons.length - 1) {
								selectedIndex++;
								updateTranslateX();
								return true;
							}
							return false;
						},
					}
				: {
						up: () => {
							if (selectedIndex > 0) {
								selectedIndex--;
								return true;
							}
							if (onUp) {
								onUp();
								return true;
							}
							return false;
						},
						down: () => {
							if (selectedIndex < buttons.length - 1) {
								selectedIndex++;
								return true;
							}
							return false;
						},
					};
		// Delay registration so ButtonsGroup handlers take priority over parent component handlers
		requestAnimationFrame(() => {
			useArea(areaID, {
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
		});
		updateTranslateX();
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
