<script lang="ts" module>
	export type ButtonsGroupContext = {
		register: (button: { onConfirm?: () => void }) => { index: number; unregister: () => void };
		isSelected: (index: number) => boolean;
		isPressed: (index: number) => boolean;
	};
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { setContext, onMount, untrack } from 'svelte';
	import { useArea, activateArea, activeArea } from '../../scripts/areas.ts';
	import type { Position } from '../../scripts/navigationLayout.ts';
	interface Props {
		children: Snippet;
		areaID: string;
		position: Position;
		initialIndex?: number;
		orientation?: 'horizontal' | 'vertical';
		onBack?: () => void;
	}
	let { children, areaID, position, initialIndex = 0, orientation = 'vertical', onBack }: Props = $props();
	let selectedIndex = $state(untrack(() => initialIndex));
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
		const gap = parseFloat(getComputedStyle(itemsElement).gap) || 0;
		offset += selectedIndex * gap;
		const selectedChild = children[selectedIndex] as HTMLElement;
		if (selectedChild) offset += selectedChild.offsetWidth / 2;
		translateX = -offset;
	}

	onMount(() => {
		const handlers =
			orientation === 'horizontal'
				? {
						up: () => false,
						down: () => false,
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
							return false;
						},
						down: () => {
							if (selectedIndex < buttons.length - 1) {
								selectedIndex++;
								return true;
							}
							return false;
						},
						left: () => false,
						right: () => false,
					};
		const unregister = useArea(
			areaID,
			{
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
			},
			position
		);
		activateArea(areaID);
		updateTranslateX();
		return unregister;
	});
</script>

<style>
	.buttons-wrapper {
		width: 100%;
		overflow: hidden;
		padding: 2vh 0;
	}

	.buttons {
		display: flex;
		align-items: center;
		gap: 3vh;
		transition: all 0.2s linear;
	}

	.buttons.horizontal {
		flex-direction: row;
		padding: 0 50%;
	}

	.buttons.vertical {
		flex-direction: column;
		gap: 2vh;
	}

	.buttons.vertical :global(.menu-button) {
		width: 100%;
	}
</style>

{#if orientation === 'horizontal'}
	<div class="buttons-wrapper">
		<div class="buttons horizontal" bind:this={itemsElement} style="transform: translateX({translateX}px)">
			{@render children()}
		</div>
	</div>
{:else}
	<div class="buttons-wrapper">
		<div class="buttons vertical">
			{@render children()}
		</div>
	</div>
{/if}
