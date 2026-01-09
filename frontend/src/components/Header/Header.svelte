<script lang="ts">
	import { onMount } from 'svelte';
	import { productName } from '../../scripts/app.ts';
	import { registerArea, activateArea, activateNextArea, activeArea } from '../../scripts/areas.ts';
	import Button from '../Buttons/Button.svelte';
	interface Props {
		onBack?: () => void;
	}
	let { onBack }: Props = $props();

	onMount(() => {
		const unregister = registerArea('header', {
			down: activateNextArea,
			confirmUp: () => onBack?.(),
			back: () => onBack?.(),
		});
		activateArea('header');
		return unregister;
	});
</script>

<style>
	.header {
		display: flex;
		align-items: center;
		gap: 1vh;
		padding: 1vh;
		background-color: var(--secondary-background);
	}

	.title {
		color: var(--primary-foreground);
		font-size: 4vh;
		font-weight: bold;
	}
</style>

<div class="header">
	<Button icon="/icons/back.svg" alt="Back" selected={$activeArea === 'header'} padding="1vh" width="5vh" height="5vh" borderRadius="50%" />
	<div class="title">{productName}</div>
</div>
