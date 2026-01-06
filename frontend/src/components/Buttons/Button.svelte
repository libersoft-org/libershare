<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import type { ButtonGroupContext } from './ButtonGroup.svelte';
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
	let { label, icon, alt = '', selected = false, pressed = false, padding = '1vw', fontSize = '1vw', borderRadius = '1vw', width, height, onConfirm }: Props = $props();

	const buttonGroup = getContext<ButtonGroupContext | undefined>('buttonGroup');
	let index = $state(-1);

	onMount(() => {
		if (buttonGroup) {
			const { index: idx, unregister } = buttonGroup.register({ onConfirm });
			index = idx;
			return unregister;
		}
	});

	let isSelected = $derived(buttonGroup ? buttonGroup.isSelected(index) : selected);
	let isPressed = $derived(buttonGroup ? buttonGroup.isPressed(index) : pressed);
</script>

<style>
	.button {
		display: flex;
		align-items: center;
		justify-content: center;
		background-color: rgba(255, 255, 255, 0.1);
		border: 0.1vw solid rgba(255, 255, 255, 0.3);
		color: #fff;
		text-align: center;
		white-space: nowrap;
		transition: all 0.2s linear;
		backdrop-filter: blur(1vw);
		opacity: 0.6;
		box-sizing: border-box;
		min-width: 8vw;
	}

	.button.icon-only {
		min-width: unset;
	}

	.button.selected {
		background-color: rgba(255, 221, 17, 0.2);
		color: #fd1;
		border-color: #fd1;
		box-shadow: 0 0 1vw rgba(255, 221, 17, 0.6);
		font-weight: bold;
		opacity: 1;
		transform: scale(1.05);
	}

	.button.selected.pressed {
		transform: scale(1);
		background-color: rgba(255, 221, 17, 0.4);
	}

	.button img {
		width: 100%;
		height: 100%;
	}
</style>

<div class="button" class:selected={isSelected} class:pressed={isSelected && isPressed} class:icon-only={icon && !label} style="padding: {padding}; font-size: {fontSize}; border-radius: {borderRadius};{width ? ` width: ${width};` : ''}{height ? ` height: ${height};` : ''}">
	{#if icon}
		<img src={icon} {alt} />
	{/if}
	{#if label}
		{label}
	{/if}
</div>
