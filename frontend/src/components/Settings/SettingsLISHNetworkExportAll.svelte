<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import { getNetworks } from '../../scripts/lishnet.ts';
	import Button from '../Buttons/Button.svelte';
	import Input from '../Input/Input.svelte';
	import Alert from '../Alert/Alert.svelte';
	interface Props {
		areaID: string;
		onBack?: () => void;
	}
	let { areaID, onBack }: Props = $props();
	let active = $derived($activeArea === areaID);
	let networks = $derived(getNetworks());
	let hasNetworks = $derived(networks.length > 0);
	let selectedIndex = $state(0); // 0 = input (if has networks), 1 = buttons row
	let selectedColumn = $state(0); // 0 = save as, 1 = back
	let inputRef: Input;

	// Get all networks from localStorage
	let networksJson = $derived(JSON.stringify(networks, null, '\t'));

	onMount(() => {
		const unregister = useArea(areaID, {
			up: () => {
				if (hasNetworks && selectedIndex > 0) {
					selectedIndex--;
					return true;
				}
				return false;
			},
			down: () => {
				if (hasNetworks && selectedIndex < 1) {
					selectedIndex++;
					selectedColumn = 0;
					return true;
				}
				return false;
			},
			left: () => {
				if (selectedIndex === 1 && selectedColumn > 0) {
					selectedColumn--;
					return true;
				}
				return false;
			},
			right: () => {
				if (selectedIndex === 1 && selectedColumn < 1) {
					selectedColumn++;
					return true;
				}
				return false;
			},
			confirmDown: () => {
				if (hasNetworks && selectedIndex === 0) inputRef?.focus();
			},
			confirmUp: () => {
				if (hasNetworks && selectedIndex === 1 && selectedColumn === 1) onBack?.();
				else if (!hasNetworks) onBack?.();
			},
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
		gap: 2vh;
	}
</style>

<div class="export-all">
	<div class="container">
		{#if hasNetworks}
			<Input bind:this={inputRef} value={networksJson} multiline rows={15} readonly fontSize="2vh" selected={active && selectedIndex === 0} />
		{:else}
			<Alert type="warning" message={$t.settings?.lishNetwork?.emptyList} />
		{/if}
	</div>
	<div class="buttons">
		{#if hasNetworks}
			<Button label="{$t.common?.saveAs} ..." selected={active && selectedIndex === 1 && selectedColumn === 0} />
		{/if}
		<Button label={$t.common?.back} selected={active && (hasNetworks ? selectedIndex === 1 && selectedColumn === 1 : true)} onConfirm={onBack} />
	</div>
</div>
