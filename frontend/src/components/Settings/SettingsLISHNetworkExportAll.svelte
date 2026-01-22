<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import { getNetworks } from '../../scripts/lishnet.ts';
	import Button from '../Buttons/Button.svelte';
	import Input from '../Input/Input.svelte';
	interface Props {
		areaID: string;
		onBack?: () => void;
	}
	let { areaID, onBack }: Props = $props();
	let active = $derived($activeArea === areaID);
	
	// Get all networks from localStorage
	let networksJson = $derived.by(() => {
		const networks = getNetworks();
		return JSON.stringify(networks, null, '\t');
	});

	onMount(() => {
		const unregister = useArea(areaID, {
			up: () => false,
			down: () => false,
			left: () => false,
			right: () => false,
			confirmDown: () => {},
			confirmUp: () => onBack?.(),
			confirmCancel: () => {},
			back: () => onBack?.(),
		});
		activateArea(areaID);
		return unregister;
	});
</script>

<style>
	.export-all {
		display: flex;
		flex-direction: column;
		align-items: center;
		height: 100%;
		padding: 2vh;
		gap: 2vh;
	}

	.container {
		display: flex;
		flex-direction: column;
		gap: 1vh;
		width: 800px;
		max-width: 100%;
	}

	.buttons {
		display: flex;
		justify-content: center;
		margin-top: 2vh;
	}
</style>

<div class="export-all">
	<div class="container">
		<Input value={networksJson} multiline rows={15} readonly fontSize="2vh" />
	</div>
	<div class="buttons">
		<Button label={$t.common?.back} selected={active} onConfirm={onBack} />
	</div>
</div>
