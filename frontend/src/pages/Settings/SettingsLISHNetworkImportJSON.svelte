<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { api } from '../../scripts/api.ts';
	import { type LISHNetworkDefinition, isCompressed } from '@shared';
	import Alert from '../../components/Alert/Alert.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import ImportOverwrite from './SettingsLISHNetworkImportOverwrite.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		initialFilePath?: string | undefined;
		onBack?: (() => void) | undefined;
		onImport?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, initialFilePath = '', onBack, onImport }: Props = $props();
	let networkJSON = $state('');
	let errorMessage = $state('');
	let parsedNetworks = $state<LISHNetworkDefinition[] | null>(null);

	async function handleImport(): Promise<void> {
		errorMessage = '';
		if (!networkJSON.trim()) {
			errorMessage = $t('settings.lishNetwork.errorInvalidFormat');
			return;
		}
		try {
			parsedNetworks = await api.lishnets.parseFromJSON(networkJSON);
		} catch (e) {
			errorMessage = e instanceof Error ? e.message : String(e);
		}
	}

	function handleOverwriteDone(): void {
		parsedNetworks = null;
		onImport?.();
		onBack?.();
		onBack?.();
	}

	async function loadInitialFile(): Promise<void> {
		if (initialFilePath) {
			try {
				const compressed = isCompressed(initialFilePath);
				const content = compressed ? await api.fs.readCompressed(initialFilePath, 'gzip') : await api.fs.readText(initialFilePath);
				if (content) {
					// Pretty-print minified JSON for readability
					try {
						const parsed = JSON.parse(content);
						networkJSON = JSON.stringify(parsed, null, '\t');
					} catch {
						networkJSON = content;
					}
				}
			} catch (e) {
				// Ignore error, user can still paste JSON manually
			}
		}
	}

	createNavArea(() => ({ areaID, position, onBack, activate: true }));

	onMount(() => {
		loadInitialFile();
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
	<ImportOverwrite networks={parsedNetworks} {position} onDone={handleOverwriteDone} />
{:else}
	<div class="import">
		<div class="container">
			<Input bind:value={networkJSON} multiline rows={15} fontSize="2vh" fontFamily="'Ubuntu Mono'" position={[0, 0]} placeholder={'{"networkID": "...", "name": "...", ...}'} />
			{#if errorMessage}
				<Alert type="error" message={errorMessage} />
			{/if}
		</div>
		<ButtonBar justify="center">
			<Button icon="/img/import.svg" label={$t('common.import')} position={[0, 1]} onConfirm={handleImport} />
			<Button icon="/img/back.svg" label={$t('common.back')} position={[1, 1]} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
