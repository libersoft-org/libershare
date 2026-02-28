<script lang="ts">
	import { onMount } from 'svelte';
	interface Props {
		checked?: boolean;
		selected?: boolean;
		disabled?: boolean;
		onToggle?: () => void;
		onConfirm?: () => void;
	}
	let { checked = false, selected = false, disabled = false, onToggle, onConfirm }: Props = $props();
	let mounted = $state(false);

	onMount(() => {
		requestAnimationFrame(() => {
			mounted = true;
		});
	});
</script>

<style>
	.switch {
		display: inline-flex;
		align-items: center;
		position: relative;
		min-width: 10vh;
		width: 10vh;
		min-height: 6vh;
		height: 6vh;
		vertical-align: middle;
	}

	.slider {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		border-radius: 3vh;
		border: 0.5vh solid var(--secondary-softer-background);
		background-color: var(--secondary-background); /* background - switched off */
	}

	.slider.checked {
		background-color: var(--primary-background); /* background - switched on */
	}

	.slider.selected {
		border-color: var(--primary-foreground);
	}

	.slider.disabled {
		border-color: var(--disabled-background);
		background-color: var(--disabled-background);
	}

	.slider.disabled.checked:before {
		background-color: var(--disabled-foreground);
	}

	.slider:before {
		/* ball - switched off */
		position: absolute;
		content: '';
		height: 4.6vh;
		width: 4.6vh;
		left: 0.25vh;
		bottom: 0.25vh;
		background-color: var(--disabled-foreground);
		border-radius: 50%;
	}

	.slider.checked:before {
		/* ball - switched on */
		transform: translateX(4vh);
		background-color: var(--primary-foreground);
	}

	.transition {
		transition: 0.4s;
	}

	.transition:before {
		transition: 0.4s;
	}
</style>

<div class="switch">
	<span class="slider {mounted ? 'transition' : ''}" class:checked class:selected class:disabled></span>
</div>
