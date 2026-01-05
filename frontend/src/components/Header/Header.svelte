<script lang="ts">
	import { onMount } from 'svelte';
	import { productName } from '../../scripts/app.ts';
	import { registerScene, activateScene, activateNextScene, activeScene } from '../../scripts/scenes.ts';
	import ButtonCircle from '../Buttons/ButtonCircle.svelte';
	interface Props {
		onBack?: () => void;
	}
	let { onBack }: Props = $props();

	onMount(() => {
		const unregister = registerScene('header', {
			down: activateNextScene,
			confirmUp: () => onBack?.(),
			back: () => onBack?.(),
		});
		activateScene('header');
		return unregister;
	});
</script>

<style>
	.header {
		display: flex;
		align-items: center;
		gap: 1vw;
		background-color: #000;
		color: #fd1;
		padding: 1vw;
		font-size: 1.5vw;
		font-weight: bold;
	}
</style>

<div class="header">
	<ButtonCircle icon="/icons/back.svg" alt="Back" selected={$activeScene === 'header'} />
	{productName}
</div>
