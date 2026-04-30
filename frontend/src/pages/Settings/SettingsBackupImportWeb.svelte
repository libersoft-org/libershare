<script lang="ts">
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { api } from '../../scripts/api.ts';
	import Alert from '../../components/Alert/Alert.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import SettingsBackupImportConfirm from './SettingsBackupImportConfirm.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
		onImport?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack, onImport }: Props = $props();
	let url = $state('');
	let errorMessage = $state('');
	let loading = $state(false);
	let parsedData = $state<Record<string, unknown> | null>(null);

	async function handleImport(): Promise<void> {
		errorMessage = '';
		if (!url.trim()) {
			errorMessage = $t('common.errorURLRequired');
			return;
		}
		loading = true;
		try {
			parsedData = await api.settings.parseFromURL(url);
		} catch (e) {
			errorMessage = translateError(e);
		} finally {
			loading = false;
		}
	}

	function handleConfirmDone(): void {
		parsedData = null;
		onImport?.();
		onBack?.();
		onBack?.();
	}

	createNavArea(() => ({ areaID, position, onBack, activate: true }));
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

{#if parsedData}
	<SettingsBackupImportConfirm data={parsedData} {position} onDone={handleConfirmDone} />
{:else}
	<div class="import">
		<div class="container">
			<Input bind:value={url} label={$t('settings.lishNetworkImport.url')} placeholder="https://..." position={[0, 0]} flex />
			{#if errorMessage}
				<Alert type="error" message={errorMessage} />
			{/if}
		</div>
		<ButtonBar justify="center" basePosition={[0, 1]}>
			<Button icon="/img/download.svg" label={$t('common.import')} onConfirm={handleImport} disabled={loading} />
			<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
