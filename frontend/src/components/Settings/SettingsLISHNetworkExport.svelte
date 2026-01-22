<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import { getNetworkById } from '../../scripts/lishnet.ts';
	import Button from '../Buttons/Button.svelte';
	import Input from '../Input/Input.svelte';
	interface Props {
		areaID: string;
		network?: { id: string; name: string } | null;
		onBack?: () => void;
	}
	let { areaID, network = null, onBack }: Props = $props();
	let active = $derived($activeArea === areaID);

	// Get full network data from localStorage
	let networkJson = $derived.by(() => {
		if (!network) return '';
		const fullNetwork = getNetworkById(network.id);
		return fullNetwork ? JSON.stringify(fullNetwork, null, '\t') : '';
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
	.export {
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

<div class="export">
	<div class="container">
		<Input value={networkJson} multiline rows={15} readonly fontSize="2vh" />
	</div>
	<div class="buttons">
		<Button label={$t.common?.back} selected={active} onConfirm={onBack} />
	</div>
</div>
