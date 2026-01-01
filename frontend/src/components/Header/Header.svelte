<script lang="ts">
	import { productName } from '../../scripts/app.ts';
	import ButtonCircle from '../Buttons/ButtonCircle.svelte';
	interface Props {
		onback?: () => void;
	}
	let { onback }: Props = $props();
</script>

<style>
	.header {
		display: flex;
		align-items: center;
		gap: 1vw;
		background: #000;
		color: #fd1;
		padding: 1vw;
		font-size: 1.5vw;
		font-weight: bold;
	}
</style>

<div class="header">
	<ButtonCircle icon="/icons/back.svg" alt="Back" onclick={onback} />
	{productName}
</div>
