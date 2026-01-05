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

	interface Props {
		children: Snippet;
		sceneID: string;
		active?: boolean;
		initialIndex?: number;
		onUp?: () => void;
		onBack?: () => void;
	}

	let { children, sceneID: sceneId, active = true, initialIndex = 0, onUp, onBack }: Props = $props();
	let selectedIndex = $state(initialIndex);
	let isAPressed = $state(false);
	let buttons: { onConfirm?: () => void }[] = [];

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

	onMount(() => {
		const unregister = registerScene(sceneId, {
			up: () => {
				if (selectedIndex > 0) selectedIndex--;
				else onUp?.();
			},
			down: () => {
				if (selectedIndex < buttons.length - 1) selectedIndex++;
			},
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
		activateScene(sceneId);
		return unregister;
	});
</script>

{@render children()}
