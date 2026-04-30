<script lang="ts">
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { api } from '../../scripts/api.ts';
	import { type IdentityBackup } from '@shared';
	import Alert from '../../components/Alert/Alert.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import SettingsIdentityImportConfirm from './SettingsIdentityImportConfirm.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
		onImport?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack, onImport }: Props = $props();
	let identityJSON = $state('');
	let errorMessage = $state('');
	let parsedData = $state<IdentityBackup | null>(null);
	let currentPeerID = $state('');

	async function handleImport(): Promise<void> {
		errorMessage = '';
		if (!identityJSON.trim()) {
			errorMessage = $t('settings.identity.errorInvalidFormat');
			return;
		}
		try {
			const current = await api.identity.get();
			currentPeerID = current.peerID;
			parsedData = await api.identity.parseFromJSON(identityJSON);
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
	<SettingsIdentityImportConfirm data={parsedData} {currentPeerID} {position} onDone={handleConfirmDone} />
{:else}
	<div class="import">
		<div class="container">
			<Input bind:value={identityJSON} multiline rows={15} fontSize="2vh" fontFamily="var(--font-mono)" position={[0, 0]} placeholder={'{"peerID": "12D3KooW...", "privateKey": "..."}'} />
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
