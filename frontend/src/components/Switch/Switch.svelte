<script lang="ts">
	import { onMount } from 'svelte';
	interface Props {
		checked?: boolean;
		selected?: boolean;
		onConfirm?: () => void;
	}
	let { checked = false, selected = false, onConfirm }: Props = $props();
	let mounted = $state(false);

	onMount(() => {
		requestAnimationFrame(() => {
			mounted = true;
		});
	});
</script>

<style>
	.switch {
		display: inline-block;
		position: relative;
		width: 10vh;
		height: 6vh;
	}

	.slider {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background-color: var(--secondary-background); /* background - switched off */
		border-radius: 3vh;
		border: 0.5vh solid var(--secondary-softer-background);
	}

	.slider.selected {
		border-color: var(--primary-foreground);
	}

	.transition {
		transition: 0.4s;
	}

	.transition:before {
		transition: 0.4s;
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

	.slider.checked {
		background-color: var(--primary-background); /* background - switched on */
	}

	.slider.checked:before {
		/* ball - switched on */
		transform: translateX(4vh);
		background-color: var(--primary-foreground);
	}
</style>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="switch" onclick={onConfirm}>
	<span class="slider {mounted ? 'transition' : ''}" class:checked class:selected></span>
</div>
