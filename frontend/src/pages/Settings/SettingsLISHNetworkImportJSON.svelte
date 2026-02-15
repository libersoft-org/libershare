<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { parseNetworksFromJson, getNetworkErrorMessage } from '../../scripts/lishNetwork.ts';
	import { type LISHNetworkDefinition } from '@libershare/shared';
	import { api } from '../../scripts/api.ts';
	import Alert from '../../components/Alert/Alert.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import ImportOverwrite from './SettingsLISHNetworkImportOverwrite.svelte';
	interface Props {
		areaID: string;
		position?: Position;
		initialFilePath?: string;
		onBack?: () => void;
		onImport?: () => void;
	}
	let { areaID, position = LAYOUT.content, initialFilePath = '', onBack, onImport }: Props = $props();
	let unregisterArea: (() => void) | null = null;
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0); // 0 = input, 1 = buttons row
	let selectedColumn = $state(0); // 0 = import, 1 = back
	let inputRef: Input | undefined = $state();
	let networkJson = $state('');
	let errorMessage = $state('');
	let parsedNetworks = $state<LISHNetworkDefinition[] | null>(null);

	async function handleImport() {
		errorMessage = '';
		const result = parseNetworksFromJson(networkJson);
		if (result.error) {
			errorMessage = getNetworkErrorMessage(result.error, $t);
			return;
		}
		parsedNetworks = result.networks;
		// Unregister our area - ImportOverwrite/ConfirmDialog will create its own
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
	}

	function handleImportDone() {
		onImport?.();
		onBack?.();
		onBack?.();
	}

	async function loadInitialFile() {
		if (initialFilePath) {
			try {
				const isGzip = initialFilePath.toLowerCase().endsWith('.gz');
				const content = isGzip ? await api.fs.readGzip(initialFilePath) : await api.fs.readText(initialFilePath);
				if (content) {
					// Pretty-print minified JSON for readability
					try {
						const parsed = JSON.parse(content);
						networkJson = JSON.stringify(parsed, null, '\t');
					} catch {
						networkJson = content;
					}
				}
			} catch (e) {
				// Ignore error, user can still paste JSON manually
			}
		}
	}

	function registerAreaHandler() {
		return useArea(
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
	}

	onMount(() => {
		loadInitialFile();
		unregisterArea = registerAreaHandler();
		activateArea(areaID);
		return () => {
			if (unregisterArea) unregisterArea();
		};
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
</style>

{#if parsedNetworks}
	<ImportOverwrite networks={parsedNetworks} {position} onDone={handleImportDone} />
{:else}
	<div class="import">
		<div class="container">
			<Input bind:this={inputRef} bind:value={networkJson} multiline rows={15} fontSize="2vh" fontFamily="'Ubuntu Mono'" selected={active && selectedIndex === 0} placeholder={'{"networkID": "...", "name": "...", ...}'} />
			{#if errorMessage}
				<Alert type="error" message={errorMessage} />
			{/if}
		</div>
		<ButtonBar justify="center">
			<Button icon="/img/import.svg" label={$t('common.import')} selected={active && selectedIndex === 1 && selectedColumn === 0} onConfirm={handleImport} />
			<Button icon="/img/back.svg" label={$t('common.back')} selected={active && selectedIndex === 1 && selectedColumn === 1} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
