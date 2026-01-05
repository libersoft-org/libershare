<script lang="ts">
	import { onMount } from 'svelte';
	import { productName } from '../../scripts/app.ts';
	import { registerArea, activateArea, activateNextArea, activeArea } from '../../scripts/areas.ts';
	import ButtonCircle from '../Buttons/ButtonCircle.svelte';
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
		gap: 1vw;
		background-color: #000;
		color: #fd1;
		padding: 1vw;
		font-size: 1.5vw;
		font-weight: bold;
	}
</style>

<div class="header">
	<ButtonCircle icon="/icons/back.svg" alt="Back" selected={$activeArea === 'header'} />
	{productName}
</div>
