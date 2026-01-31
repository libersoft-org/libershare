<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import type { Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { importNetworksFromJson, getNetworkErrorMessage } from '../../scripts/lishNetwork.ts';
	import Alert from '../Alert/Alert.svelte';
	import Button from '../Buttons/Button.svelte';
	import Input from '../Input/Input.svelte';

	interface Props {
		areaID: string;
		position?: Position;
		onBack?: () => void;
		onImport?: () => void;
	}
	let { areaID, position = LAYOUT.content, onBack, onImport }: Props = $props();
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0); // 0 = input, 1 = buttons row
	let selectedColumn = $state(0); // 0 = import, 1 = back
	let inputRef: Input | undefined = $state();
	let networkJson = $state('');
	let errorMessage = $state('');

	function handleImport() {
		errorMessage = '';
		const result = importNetworksFromJson(networkJson);
		if (result.error) {
			errorMessage = getNetworkErrorMessage(result.error, $t);
			return;
		}
		onImport?.();
	}

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
					if (selectedIndex === 1) {
						if (selectedColumn === 0) {
							handleImport();
						} else if (selectedColumn === 1) {
							onBack?.();
						}
					}
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
	.import {
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

<div class="import">
	<div class="container">
		<Input bind:this={inputRef} bind:value={networkJson} multiline rows={15} fontSize="2vh" fontFamily="'Ubuntu Mono'" selected={active && selectedIndex === 0} placeholder={'{"networkID": "...", "name": "...", ...}'} />
		{#if errorMessage}
			<Alert type="error" message={errorMessage} />
		{/if}
	</div>
	<div class="buttons">
		<Button icon="/img/import.svg" label={$t.common?.import} selected={active && selectedIndex === 1 && selectedColumn === 0} onConfirm={handleImport} />
		<Button icon="/img/back.svg" label={$t.common?.back} selected={active && selectedIndex === 1 && selectedColumn === 1} onConfirm={onBack} />
	</div>
</div>
