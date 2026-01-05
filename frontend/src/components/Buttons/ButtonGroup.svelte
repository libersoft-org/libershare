<script lang="ts" module>
	export type ButtonGroupContext = {
		register: (button: { onConfirm?: () => void }) => { index: number; unregister: () => void };
		isSelected: (index: number) => boolean;
		isPressed: (index: number) => boolean;
	};
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { setContext, onMount } from 'svelte';
	import { registerScene, activateScene } from '../../scripts/scenes.ts';
	import { focusArea } from '../../scripts/navigation.ts';

	interface Props {
		children: Snippet;
		sceneID: string;
		initialIndex?: number;
		orientation?: 'horizontal' | 'vertical';
		wrap?: boolean;
		onUp?: () => void;
		onBack?: () => void;
	}

	let { children, sceneID, initialIndex = 0, orientation = 'vertical', wrap = false, onUp, onBack }: Props = $props();
	let selectedIndex = $state(initialIndex);
	let isAPressed = $state(false);
	let buttons: { onConfirm?: () => void }[] = [];
	let active = $derived($focusArea === 'content');

	setContext<ButtonGroupContext>('buttonGroup', {
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

	function navigatePrev() {
		if (selectedIndex > 0) selectedIndex--;
		else if (wrap) selectedIndex = buttons.length - 1;
		else onUp?.();
	}

	function navigateNext() {
		if (selectedIndex < buttons.length - 1) selectedIndex++;
		else if (wrap) selectedIndex = 0;
	}

	onMount(() => {
		const handlers = orientation === 'horizontal' ? { left: navigatePrev, right: navigateNext, up: () => onUp?.() } : { up: navigatePrev, down: navigateNext };
		const unregister = registerScene(sceneID, {
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
		activateScene(sceneID);
		return unregister;
	});
</script>

<style>
	.items-wrapper {
		width: 100%;
		overflow: hidden;
		padding: 1vw 0;
	}

	.items {
		display: flex;
		align-items: center;
		gap: 1.5vw;
		transition: all 0.2s linear;
	}

	.items.horizontal {
		flex-direction: row;
		padding: 0 calc(50vw - 100px);
	}

	.items.vertical {
		flex-direction: column;
		gap: 1vw;
	}

	.items.vertical :global(.menu-button) {
		width: 100%;
	}
</style>

{#if orientation === 'horizontal'}
	<div class="items-wrapper">
		<div class="items horizontal" style="transform: translateX(calc({selectedIndex} * -232px))">
			{@render children()}
		</div>
	</div>
{:else}
	<div class="items vertical">
		{@render children()}
	</div>
{/if}
