<script lang="ts">
	import { onMount } from 'svelte';
	import { productName } from '../../scripts/app.ts';
	import { useArea, activateArea, activeArea } from '../../scripts/areas.ts';
	import Button from '../Buttons/Button.svelte';
	interface Props {
		areaID: string;
		onBack?: () => void;
	}
	let { areaID, onBack }: Props = $props();
	let active = $derived($activeArea === areaID);

	onMount(() => {
		return useArea(areaID, {
			confirmUp: () => onBack?.(),
			back: () => onBack?.(),
		});
	});
</script>

<style>
	.header {
		display: flex;
		align-items: center;
		gap: 1vh;
		padding: 1vh;
		background-color: var(--secondary-background);
		border-bottom: 0.2vh solid var(--secondary-softer-background);
	}

	.title {
		color: var(--primary-foreground);
		font-size: 4vh;
		font-weight: bold;
	}
</style>

<div class="header">
	<Button icon="/icons/back.svg" alt="Back" selected={active} padding="1vh" width="5vh" height="5vh" borderRadius="50%" />
	<div class="title">{productName}</div>
</div>
