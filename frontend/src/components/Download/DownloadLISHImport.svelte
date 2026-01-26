<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import type { Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { navigateTo } from '../../scripts/navigation.ts';
	import { parseLISHFromJson, getLISHErrorMessage } from '../../scripts/lish.ts';
	import Alert from '../Alert/Alert.svelte';
	import Button from '../Buttons/Button.svelte';
	import Input from '../Input/Input.svelte';

	interface Props {
		areaID: string;
		position?: Position;
		onBack?: () => void;
		onImport?: () => void;
	}
	let { areaID, position = CONTENT_POSITIONS.main, onBack, onImport }: Props = $props();
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0); // 0 = input, 1 = buttons row
	let selectedColumn = $state(0); // 0 = load from file, 1 = import, 2 = back
	let inputRef: Input;
	let lishJson = $state('');
	let errorMessage = $state('');

	function handleImport() {
		errorMessage = '';
		const result = parseLISHFromJson(lishJson);
		if (result.error) {
			errorMessage = getLISHErrorMessage(result.error, $t);
			return;
		}
		// TODO: Add LISH items to storage/backend
		// result.items contains validated LISH objects
		onImport?.();
	}

	function openFileBrowser() {
		navigateTo('import-lish-browse');
	}

	const areaHandlers = {
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
			if (selectedIndex === 1 && selectedColumn < 2) {
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
					openFileBrowser();
				} else if (selectedColumn === 1) {
					handleImport();
				} else if (selectedColumn === 2) {
					onBack?.();
				}
			}
		},
		confirmCancel: () => {},
		back: () => onBack?.(),
	};

	onMount(() => {
		const unregister = useArea(areaID, areaHandlers, position);
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
		<Input bind:this={inputRef} bind:value={lishJson} multiline rows={10} placeholder={$t.downloads?.importPlaceholder} fontSize="2vh" selected={active && selectedIndex === 0} />
		{#if errorMessage}
			<Alert type="error" message={errorMessage} />
		{/if}
	</div>
	<div class="buttons">
		<Button icon="/img/folder.svg" label="{$t.common?.load} ..." selected={active && selectedIndex === 1 && selectedColumn === 0} />
		<Button icon="/img/download.svg" label={$t.common?.import} selected={active && selectedIndex === 1 && selectedColumn === 1} onConfirm={handleImport} />
		<Button icon="/img/back.svg" label={$t.common?.back} selected={active && selectedIndex === 1 && selectedColumn === 2} onConfirm={onBack} />
	</div>
</div>
