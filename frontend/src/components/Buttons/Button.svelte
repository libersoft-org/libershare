<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import type { ButtonsGroupContext } from './ButtonsGroup.svelte';
	interface Props {
		label?: string;
		icon?: string;
		alt?: string;
		selected?: boolean;
		pressed?: boolean;
		padding?: string;
		fontSize?: string;
		borderRadius?: string;
		width?: string;
		height?: string;
		onConfirm?: () => void;
	}
	let { label, icon, alt = '', selected = false, pressed = false, padding = '2vh', fontSize = '2vh', borderRadius = '2vh', width, height, onConfirm }: Props = $props();

	const buttonsGroup = getContext<ButtonsGroupContext | undefined>('buttonsGroup');
	let index = $state(-1);

	onMount(() => {
		if (buttonsGroup) {
			const { index: idx, unregister } = buttonsGroup.register({ onConfirm });
			index = idx;
			return unregister;
		}
	});

	let isSelected = $derived(buttonsGroup ? buttonsGroup.isSelected(index) : selected);
	let isPressed = $derived(buttonsGroup ? buttonsGroup.isPressed(index) : pressed);
</script>

<style>
	.button {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 1vh;
		background-color: var(--secondary-background);
		color: var(--secondary-foreground);
		border: 0.4vh solid var(--secondary-softer-background);
		text-align: center;
		white-space: nowrap;
		transition: all 0.2s linear;
		backdrop-filter: blur(2vh);
		opacity: 0.6;
		box-sizing: border-box;
		min-width: 16vh;
	}

	.button.icon-only {
		min-width: unset;
	}

	.button.selected {
		background-color: var(--primary-background);
		color: var(--primary-foreground);
		border-color: var(--primary-foreground);
		box-shadow: 0 0 1.5vh var(--primary-foreground);
		font-weight: bold;
		opacity: 1;
		transform: scale(1.05);
	}

	.button.selected.pressed {
		transform: scale(1);
		background-color: var(--primary-softer-background);
	}
</style>

<div class="button" class:selected={isSelected} class:pressed={isSelected && isPressed} class:icon-only={icon && !label} style="padding: {padding}; font-size: {fontSize}; border-radius: {borderRadius};{width ? ` width: ${width};` : ''}{height ? ` height: ${height};` : ''}">
	{#if icon}
		<img src={icon} {alt} style="width: {fontSize}; height: {fontSize};" />
	{/if}
	{#if label}
		{label}
	{/if}
</div>
