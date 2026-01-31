<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import type { Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { importNetworksFromJson, getNetworkErrorMessage } from '../../scripts/lishNetwork.ts';
	import { api } from '../../scripts/api.ts';
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
	// 0 = url, 1 = buttons row
	let selectedIndex = $state(0);
	let selectedColumn = $state(0);
	let urlRef: Input | undefined = $state();
	let url = $state('');
	let errorMessage = $state('');
	let loading = $state(false);

	function getMaxColumn(index: number): number {
		if (index === 1) return 1; // import, back
		return 0;
	}

	async function handleImport() {
		errorMessage = '';
		if (!url.trim()) {
			errorMessage = $t('settings.lishNetworkImport.urlRequired');
			return;
		}
		loading = true;
		try {
			// Use backend API to bypass CORS restrictions
			const response = await api.fetchUrl(url);
			if (response.status !== 200) {
				errorMessage = `HTTP ${response.status}`;
				return;
			}
			const result = importNetworksFromJson(response.content);
			if (result.error) {
				errorMessage = getNetworkErrorMessage(result.error, $t);
				return;
			}
			onImport?.();
		} catch (e) {
			errorMessage = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	const areaHandlers = {
		up: () => {
			if (selectedIndex > 0) {
				selectedIndex--;
				selectedColumn = 0;
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
			if (selectedColumn > 0) {
				selectedColumn--;
				return true;
			}
			return false;
		},
		right: () => {
			const maxCol = getMaxColumn(selectedIndex);
			if (selectedColumn < maxCol) {
				selectedColumn++;
				return true;
			}
			return false;
		},
		confirmDown: () => {
			if (selectedIndex === 0) urlRef?.focus();
		},
		confirmUp: () => {
			if (selectedIndex === 1) {
				if (selectedColumn === 0) handleImport();
				else if (selectedColumn === 1) onBack?.();
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
		<Input bind:this={urlRef} bind:value={url} label={$t('settings.lishNetworkImport.url')} placeholder="https://..." selected={active && selectedIndex === 0} flex />
		{#if errorMessage}
			<Alert type="error" message={errorMessage} />
		{/if}
	</div>
	<div class="buttons">
		<Button icon="/img/download.svg" label={$t('common.import')} selected={active && selectedIndex === 1 && selectedColumn === 0} onConfirm={handleImport} disabled={loading} />
		<Button icon="/img/back.svg" label={$t('common.back')} selected={active && selectedIndex === 1 && selectedColumn === 1} onConfirm={onBack} />
	</div>
</div>
