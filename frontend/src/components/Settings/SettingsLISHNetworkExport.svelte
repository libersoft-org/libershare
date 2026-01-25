<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import type { Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { getNetworkById } from '../../scripts/lishnet.ts';
	import Button from '../Buttons/Button.svelte';
	import Input from '../Input/Input.svelte';
	interface Props {
		areaID: string;
		position?: Position;
		network?: { id: string; name: string } | null;
		onBack?: () => void;
	}
	let { areaID, position = CONTENT_POSITIONS.main, network = null, onBack }: Props = $props();
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0); // 0 = input, 1 = save as, 2 = back button
	let selectedColumn = $state(0); // 0 = save as, 1 = back
	let inputRef: Input;

	// Get full network data from localStorage
	let networkJson = $derived.by(() => {
		if (!network) return '';
		const fullNetwork = getNetworkById(network.id);
		return fullNetwork ? JSON.stringify(fullNetwork, null, '\t') : '';
	});

	onMount(() => {
		const unregister = useArea(
			areaID,
			{
				up: () => {
					if (selectedIndex > 0) {
						selectedIndex--;
						return true;
					}
					return false;
				},
				down: () => {
					if (selectedIndex < 1) {
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
					if (selectedIndex === 0) inputRef?.focus();
				},
				confirmUp: () => {
					if (selectedIndex === 1 && selectedColumn === 1) onBack?.();
				},
				confirmCancel: () => {},
				back: () => onBack?.(),
			},
			position
		);
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
		gap: 2vh;
	}
</style>

<div class="export">
	<div class="container">
		<Input bind:this={inputRef} value={networkJson} multiline rows={15} readonly fontSize="2vh" selected={active && selectedIndex === 0} />
	</div>
	<div class="buttons">
		<Button label="{$t.common?.saveAs} ..." selected={active && selectedIndex === 1 && selectedColumn === 0} />
		<Button icon="/img/back.svg" label={$t.common?.back} selected={active && selectedIndex === 1 && selectedColumn === 1} onConfirm={onBack} />
	</div>
</div>
