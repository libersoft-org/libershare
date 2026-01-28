<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import type { ButtonsGroupContext } from './ButtonsGroup.svelte';
	import Icon from '../Icon/Icon.svelte';
	interface Props {
		label?: string;
		icon?: string;
		iconPosition?: 'left' | 'top';
		iconSize?: string;
		noColorFilter?: boolean;
		badgeIcon?: string;
		alt?: string;
		selected?: boolean;
		pressed?: boolean;
		active?: boolean;
		disabled?: boolean;
		padding?: string;
		fontSize?: string;
		borderRadius?: string;
		width?: string;
		height?: string;
		onConfirm?: () => void;
	}
	let { label, icon, iconPosition = 'left', iconSize, noColorFilter = false, badgeIcon, alt = '', selected = false, pressed = false, active = false, disabled = false, padding = '2vh', fontSize = '2vh', borderRadius = '2vh', width, height, onConfirm }: Props = $props();
	const buttonsGroup = getContext<ButtonsGroupContext | undefined>('buttonsGroup');
	let index = $state(-1);
	let isSelected = $derived(buttonsGroup ? buttonsGroup.isSelected(index) : selected);
	let isPressed = $derived(buttonsGroup ? buttonsGroup.isPressed(index) : pressed);

	onMount(() => {
		if (buttonsGroup) {
			const { index: idx, unregister } = buttonsGroup.register({ onConfirm });
			index = idx;
			return unregister;
		}
	});
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
	}

	.button.icon-only {
		min-width: unset;
	}

	.button.icon-top {
		flex-direction: column;
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

	.button.active {
		border-color: var(--color-success);
		box-shadow: 0 0 1.5vh var(--color-success);
		opacity: 1;
	}
</style>

<div class="button" class:selected={isSelected} class:pressed={isSelected && isPressed} class:active class:disabled class:icon-only={icon && !label} class:icon-top={iconPosition === 'top'} style="padding: {padding}; font-size: {fontSize}; border-radius: {borderRadius}; min-width: {width ?? '16vh'};{height ? ` height: ${height};` : ''}">
	{#if icon}
		<Icon img={icon} {alt} size={iconSize ?? fontSize} padding="0" colorVariable={isSelected ? '--primary-foreground' : '--disabled-foreground'} {noColorFilter} {badgeIcon} badgeColorVariable={isSelected ? '--primary-foreground' : '--disabled-foreground'} />
	{/if}
	{#if label}
		{label}
	{/if}
</div>
