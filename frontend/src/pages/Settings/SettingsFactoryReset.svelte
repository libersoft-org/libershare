<script lang="ts">
	import { tick } from 'svelte';
	import { t, tt, translateError } from '../../scripts/language.ts';
	import { activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { api } from '../../scripts/api.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	import ConfirmDialog from '../../components/Dialog/ConfirmDialog.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();

	// Each category defaults to ON so a plain confirm wipes everything.
	let resetSettings = $state(true);
	let resetIdentity = $state(true);
	let resetDownloads = $state(true);
	let resetNetworks = $state(true);
	let busy = $state(false);
	let errorMessage = $state('');
	let showConfirm = $state(false);

	let anySelected = $derived(resetSettings || resetIdentity || resetDownloads || resetNetworks);

	function askReset(): void {
		errorMessage = '';
		if (!anySelected) {
			errorMessage = $t('settings.factoryReset.nothingSelected');
			return;
		}
		showConfirm = true;
	}

	async function confirmReset(): Promise<void> {
		showConfirm = false;
		busy = true;
		errorMessage = '';
		try {
			const res = await api.settings.factoryReset({ settings: resetSettings, identity: resetIdentity, downloads: resetDownloads, networks: resetNetworks });
			// Each category is wiped independently — build one notification per category and
			// stash the already-translated strings so they survive the reload below.
			const labelKey: Record<string, string> = { settings: 'optionSettings', identity: 'optionIdentity', downloads: 'optionDownloads', networks: 'optionNetworks' };
			const notifications = res.results.map(r => {
				const category = tt('settings.factoryReset.' + labelKey[r.category]);
				return r.ok ? { text: tt('settings.factoryReset.categoryDone', { category }), type: 'success' } : { text: tt('settings.factoryReset.categoryFailed', { category, detail: r.detail ?? '' }), type: 'error' };
			});
			sessionStorage.setItem('factoryResetNotifications', JSON.stringify(notifications));
			// Selected state changed across many stores — reload from a clean slate.
			window.location.reload();
		} catch (e) {
			errorMessage = tt('settings.factoryReset.error', { detail: translateError(e) });
			busy = false;
		}
	}

	async function cancelReset(): Promise<void> {
		showConfirm = false;
		await tick();
		activateArea(areaID);
	}

	createNavArea(() => ({ areaID, position, onBack, activate: true }));
</script>

<style>
	.factory-reset {
		display: flex;
		flex-direction: column;
		align-items: center;
		height: 100%;
		padding: 2vh;
		gap: 1.5vh;
		overflow-y: auto;
	}

	.container {
		display: flex;
		flex-direction: column;
		gap: 1vh;
		width: 900px;
		max-width: 100%;
	}

	.intro {
		font-size: 2vh;
		color: var(--secondary-foreground);
		line-height: 1.6;
	}
</style>

<div class="factory-reset">
	<div class="container">
		<div class="intro">{$t('settings.factoryReset.intro')}</div>
		<div role="group" data-mouse-activate-area={areaID}>
			<SwitchRow label={$t('settings.factoryReset.optionSettings')} checked={resetSettings} disabled={busy} position={[0, 0]} onToggle={() => (resetSettings = !resetSettings)} />
		</div>
		<div role="group" data-mouse-activate-area={areaID}>
			<SwitchRow label={$t('settings.factoryReset.optionIdentity')} checked={resetIdentity} disabled={busy} position={[0, 1]} onToggle={() => (resetIdentity = !resetIdentity)} />
		</div>
		<div role="group" data-mouse-activate-area={areaID}>
			<SwitchRow label={$t('settings.factoryReset.optionDownloads')} checked={resetDownloads} disabled={busy} position={[0, 2]} onToggle={() => (resetDownloads = !resetDownloads)} />
		</div>
		<div role="group" data-mouse-activate-area={areaID}>
			<SwitchRow label={$t('settings.factoryReset.optionNetworks')} checked={resetNetworks} disabled={busy} position={[0, 3]} onToggle={() => (resetNetworks = !resetNetworks)} />
		</div>
		<Alert type="warning" message={$t('settings.factoryReset.warning')} />
		{#if errorMessage}
			<Alert type="error" message={errorMessage} />
		{/if}
	</div>
	<ButtonBar justify="center" basePosition={[0, 4]}>
		<Button icon="/img/factory-reset.svg" label={busy ? $t('settings.factoryReset.resetting') : $t('settings.factoryReset.reset')} disabled={busy} onConfirm={askReset} />
		<Button icon="/img/back.svg" label={$t('common.back')} disabled={busy} onConfirm={onBack} />
	</ButtonBar>
</div>
{#if showConfirm}
	<ConfirmDialog title={$t('settings.factoryReset.confirmTitle')} message={$t('settings.factoryReset.confirmMessage')} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" defaultButton="cancel" {position} onConfirm={confirmReset} onBack={cancelReset} />
{/if}
