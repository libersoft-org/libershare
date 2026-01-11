<script lang="ts">
	interface Props {
		checked?: boolean;
	}
	let { checked = false }: Props = $props();
	let mounted = $state(false);

	$effect(() => {
		requestAnimationFrame(() => {
			mounted = true;
		});
	});
</script>

<style>
	.switch {
		display: inline-block;
		position: relative;
		width: 60px;
		height: 34px;
	}

	.slider {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background-color: var(--disabled-background);
		border-radius: 34px;
		border: 1px solid var(--primary-foreground);
	}

	.transition {
		transition: 0.4s;
	}

	.transition:before {
		transition: 0.4s;
	}

	.slider:before {
		position: absolute;
		content: '';
		height: 26px;
		width: 26px;
		left: 3px;
		bottom: 3px;
		background-color: var(--primary-foreground);
		border-radius: 50%;
	}

	.slider.checked {
		background-color: var(--primary-background);
	}

	.slider.checked:before {
		transform: translateX(26px);
	}
</style>

<div class="switch">
	<span class="slider {mounted ? 'transition' : ''}" class:checked></span>
</div>
