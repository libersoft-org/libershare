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
	import { registerArea, activateArea, activatePrevArea, activeArea } from '../../scripts/areas.ts';

	interface Props {
		children: Snippet;
		areaID: string;
		initialIndex?: number;
		orientation?: 'horizontal' | 'vertical';
		wrap?: boolean;
		onBack?: () => void;
	}

	let { children, areaID, initialIndex = 0, orientation = 'vertical', wrap = false, onBack }: Props = $props();
	let selectedIndex = $state(initialIndex);
	let isAPressed = $state(false);
	let buttons: { onConfirm?: () => void }[] = [];
	let active = $derived($activeArea === areaID);

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
		else activatePrevArea();
	}

	function navigateNext() {
		if (selectedIndex < buttons.length - 1) selectedIndex++;
		else if (wrap) selectedIndex = 0;
	}

	onMount(() => {
		const handlers = orientation === 'horizontal' ? { left: navigatePrev, right: navigateNext, up: activatePrevArea } : { up: navigatePrev, down: navigateNext };
		const unregister = registerArea(areaID, {
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
