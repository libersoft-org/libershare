<script lang="ts">
	import { onMount } from 'svelte';
	import { productName } from '../../scripts/app.ts';
	import { registerScene } from '../../scripts/input.ts';
	import { focusArea, focusContent } from '../../scripts/navigation.ts';
	import ButtonCircle from '../Buttons/ButtonCircle.svelte';
	interface Props {
		onback?: () => void;
	}
	let { onback }: Props = $props();

	onMount(() => {
		return registerScene('header', {
			down: () => focusContent(),
			confirmDown: () => onback?.(),
			back: () => onback?.(),
		});
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
	<ButtonCircle icon="/icons/back.svg" alt="Back" selected={$focusArea === 'header'} />
	{productName}
</div>
