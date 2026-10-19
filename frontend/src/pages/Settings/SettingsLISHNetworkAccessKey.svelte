<script lang="ts">
	import { onMount } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { copyToClipboard } from '../../scripts/clipboard.ts';
	import { api } from '../../scripts/api.ts';
	import { type LISHNetworkConfig } from '@shared';
	import Alert from '../../components/Alert/Alert.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		network: LISHNetworkConfig;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, network, onBack }: Props = $props();

	/** The CA key once shown (founder), or what is typed to restore it. */
	let key = $state('');
	let founder = $state<boolean | null>(null);
	let busy = $state(false);

	onMount(async () => {
		try {
			founder = (await api.overlay.status(network.networkID)).role === 'founder';
		} catch (e) {
			addNotification(translateError(e), 'error');
		}
	});

	async function show(forDevice: boolean): Promise<void> {
		try {
			key = (await api.overlay.exportCA(network.networkID, forDevice)).caKey;
		} catch (e) {
			addNotification(translateError(e), 'error');
		}
	}

	async function restore(): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			await api.overlay.importCA(network.networkID, key);
			key = '';
			founder = true;
			addNotification($t('settings.lishNetwork.protected.caRestored'), 'success');
		} catch (e) {
			addNotification(translateError(e), 'error');
		} finally {
			busy = false;
		}
	}

	createNavArea(() => ({ areaID, position, onBack, activate: true }));
</script>

<style>
	.page {
		display: flex;
		flex-direction: column;
		align-items: center;
		height: 100%;
		padding: 2vh;
		gap: 2vh;
		overflow-y: auto;
	}

	.container {
		display: flex;
		flex-direction: column;
		gap: 1.5vh;
		width: 1000px;
		max-width: 100%;
	}
</style>

<div class="page">
	<div class="container">
		<Alert type="warning" message={$t('settings.lishNetwork.protected.backupWarning')} />
		{#if founder === true}
			{#if !key}
				<Alert type="info" message={$t('settings.lishNetwork.protected.backupForDeviceHint')} />
			{/if}
			{#if key}
				<div role="group" data-mouse-activate-area={areaID}>
					<Input value={key} label={$t('settings.lishNetwork.protected.caKey')} multiline rows={4} readonly fontSize="1.6vh" fontFamily="var(--font-mono)" position={[0, 0]} />
				</div>
			{/if}
			<ButtonBar justify="center" basePosition={[0, 1]}>
				{#if key}
					<Button icon="/img/copy.svg" label={$t('settings.lishNetwork.protected.copy')} onConfirm={() => copyToClipboard(key, $t('settings.lishNetwork.protected.copied'))} />
				{:else}
					<Button icon="/img/key.svg" label={$t('settings.lishNetwork.protected.backupCA')} onConfirm={() => show(false)} />
					<Button icon="/img/key.svg" label={$t('settings.lishNetwork.protected.backupForDevice')} onConfirm={() => show(true)} />
				{/if}
				<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} />
			</ButtonBar>
		{:else if founder === false}
			<div role="group" data-mouse-activate-area={areaID}>
				<Input bind:value={key} label={$t('settings.lishNetwork.protected.caKey')} multiline rows={4} fontSize="1.6vh" fontFamily="var(--font-mono)" placeholder="-----BEGIN NEBULA ED25519 PRIVATE KEY-----" position={[0, 0]} />
			</div>
			<ButtonBar justify="center" basePosition={[0, 1]}>
				<Button icon="/img/import.svg" label={$t('settings.lishNetwork.protected.restoreCA')} disabled={busy || !key.trim()} onConfirm={restore} />
				<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} />
			</ButtonBar>
		{/if}
	</div>
</div>
