<script lang="ts">
	import { tick } from 'svelte';
	import { t, tt, translateError } from '../../scripts/language.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { createSubPage } from '../../scripts/subPage.svelte.ts';
	import { navigateTo } from '../../scripts/navigation.ts';
	import { api } from '../../scripts/api.ts';
	import { type NetworkNodeInfo } from '@shared';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import NodeInfoRow from '../../components/NodeInfo/NodeInfoRow.svelte';
	import ConfirmDialog from '../../components/Dialog/ConfirmDialog.svelte';
	import SettingsIdentityExport from './SettingsIdentityExport.svelte';

	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();

	let nodeInfo = $state<NetworkNodeInfo | null>(null);
	let showAddresses = $state(false);
	let errorMessage = $state('');
	let busy = $state(false);
	let showRegenerateConfirm = $state(false);

	async function loadNodeInfo(): Promise<void> {
		try {
			const info = await api.lishnets.getNodeInfo();
			nodeInfo = info;
		} catch (e) {
			errorMessage = translateError(e);
		}
	}

	void loadNodeInfo();

	const navHandle = createNavArea(() => ({ areaID, position, onBack, activate: true }));
	const exportSubPage = createSubPage(navHandle, areaID);

	async function closeExport(): Promise<void> {
		await exportSubPage.exit();
		await loadNodeInfo();
	}

	function openExport(): void {
		exportSubPage.enter($t('common.export'), () => void closeExport());
	}

	function openImport(): void {
		navigateTo('import-identity');
	}

	function askRegenerate(): void {
		showRegenerateConfirm = true;
	}

	async function confirmRegenerate(): Promise<void> {
		showRegenerateConfirm = false;
		busy = true;
		errorMessage = '';
		try {
			await api.identity.regenerate();
			addNotification(tt('settings.identity.regenerated'), 'success');
			await loadNodeInfo();
		} catch (e) {
			errorMessage = translateError(e);
		} finally {
			busy = false;
		}
	}

	async function cancelRegenerate(): Promise<void> {
		showRegenerateConfirm = false;
		await tick();
		activateArea(areaID);
	}
</script>

<style>
	.identity {
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

{#if !exportSubPage.active}
	<div class="identity">
		<ButtonBar justify="center" basePosition={[0, 0]}>
			<Button icon="/img/download.svg" label={$t('common.import')} disabled={busy} onConfirm={openImport} />
			<Button icon="/img/upload.svg" label={$t('common.export')} disabled={busy} onConfirm={openExport} />
			<Button icon="/img/restart.svg" label={$t('settings.identity.regenerate')} disabled={busy} onConfirm={askRegenerate} />
		</ButtonBar>
		<div class="container">
			{#if errorMessage}
				<Alert type="error" message={errorMessage} />
			{/if}
			{#if nodeInfo}
				<NodeInfoRow {nodeInfo} rowY={1} bind:showAddresses />
			{/if}
		</div>
	</div>
	{#if showRegenerateConfirm}
		<ConfirmDialog title={$t('settings.identity.regenerateTitle')} message={$t('settings.identity.regenerateConfirm')} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" defaultButton="cancel" {position} onConfirm={confirmRegenerate} onBack={cancelRegenerate} />
	{/if}
{:else}
	<SettingsIdentityExport {areaID} {position} onBack={() => void closeExport()} />
{/if}
