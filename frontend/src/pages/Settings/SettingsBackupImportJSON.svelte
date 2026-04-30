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
	let backupJSON = $state('');
	let errorMessage = $state('');
	let parsedData = $state<Record<string, unknown> | null>(null);

	async function handleImport(): Promise<void> {
		errorMessage = '';
		if (!backupJSON.trim()) {
			errorMessage = $t('settings.backup.errorInvalidFormat');
			return;
		}
		try {
			parsedData = await api.settings.parseFromJSON(backupJSON);
		} catch (e) {
			errorMessage = translateError(e);
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
			<Input bind:value={backupJSON} multiline rows={15} fontSize="2vh" fontFamily="var(--font-mono)" position={[0, 0]} placeholder={'{"language": "...", "ui": {...}, ...}'} />
			{#if errorMessage}
				<Alert type="error" message={errorMessage} />
			{/if}
		</div>
		<ButtonBar justify="center" basePosition={[0, 1]}>
			<Button icon="/img/import.svg" label={$t('common.import')} onConfirm={handleImport} />
			<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
