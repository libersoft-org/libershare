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
	import Spinner from '../../components/Spinner/Spinner.svelte';
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
	let errorMessage = $state('');
	let showConfirm = $state(false);
	// View phase: the form, a spinner while wiping, then the per-category results.
	let phase = $state<'form' | 'running' | 'done'>('form');
	// Per-category outcomes shown on the done page — one alert each.
	let resultAlerts = $state<Array<{ type: 'info' | 'error'; message: string }>>([]);

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
		errorMessage = '';
		resultAlerts = [];
		phase = 'running';
		try {
			const res = await api.settings.factoryReset({ settings: resetSettings, identity: resetIdentity, downloads: resetDownloads, networks: resetNetworks });
			// Each category is wiped independently — one alert per category on the done page.
			const labelKey: Record<string, string> = { settings: 'optionSettings', identity: 'optionIdentity', downloads: 'optionDownloads', networks: 'optionNetworks' };
			resultAlerts = res.results.map(r => {
				const category = tt('settings.factoryReset.' + labelKey[r.category]);
				return r.ok ? { type: 'info' as const, message: tt('settings.factoryReset.categoryDone', { category }) } : { type: 'error' as const, message: tt('settings.factoryReset.categoryFailed', { category, detail: r.detail ?? '' }) };
			});
			phase = 'done';
		} catch (e) {
			// Transport-level failure — the reset never ran. Back to the form with the error.
			errorMessage = tt('settings.factoryReset.error', { detail: translateError(e) });
			phase = 'form';
		}
		await tick();
		activateArea(areaID);
	}

	// Full reload re-syncs every store (downloads, networks, settings, identity) after the wipe.
	function reloadApp(): void {
		window.location.reload();
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

	.status-page {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2vh;
		flex: 1;
	}

	.status-text {
		font-size: 2.2vh;
		color: var(--secondary-foreground);
	}
</style>

{#if phase === 'running'}
	<div class="factory-reset">
		<div class="status-page">
			<Spinner size="8vh" />
			<div class="status-text">{$t('settings.factoryReset.resetting')}</div>
		</div>
	</div>
{:else if phase === 'done'}
	<div class="factory-reset">
		<div class="container">
			{#each resultAlerts as a (a.message)}
				<Alert type={a.type} message={a.message} />
			{/each}
		</div>
		<ButtonBar justify="center" basePosition={[0, 0]}>
			<Button icon="/img/restart.svg" label={$t('settings.factoryReset.reloadApp')} onConfirm={reloadApp} />
		</ButtonBar>
	</div>
{:else}
	<div class="factory-reset">
		<div class="container">
			<div class="intro">{$t('settings.factoryReset.intro')}</div>
			<div role="group" data-mouse-activate-area={areaID}>
				<SwitchRow label={$t('settings.factoryReset.optionSettings')} checked={resetSettings} position={[0, 0]} onToggle={() => (resetSettings = !resetSettings)} />
			</div>
			<div role="group" data-mouse-activate-area={areaID}>
				<SwitchRow label={$t('settings.factoryReset.optionIdentity')} checked={resetIdentity} position={[0, 1]} onToggle={() => (resetIdentity = !resetIdentity)} />
			</div>
			<div role="group" data-mouse-activate-area={areaID}>
				<SwitchRow label={$t('settings.factoryReset.optionDownloads')} checked={resetDownloads} position={[0, 2]} onToggle={() => (resetDownloads = !resetDownloads)} />
			</div>
			<div role="group" data-mouse-activate-area={areaID}>
				<SwitchRow label={$t('settings.factoryReset.optionNetworks')} checked={resetNetworks} position={[0, 3]} onToggle={() => (resetNetworks = !resetNetworks)} />
			</div>
			<Alert type="warning" message={$t('settings.factoryReset.warning')} />
			{#if errorMessage}
				<Alert type="error" message={errorMessage} />
			{/if}
		</div>
		<ButtonBar justify="center" basePosition={[0, 4]}>
			<Button icon="/img/factory-reset.svg" label={$t('settings.factoryReset.reset')} onConfirm={askReset} />
			<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
{#if showConfirm}
	<ConfirmDialog title={$t('settings.factoryReset.confirmTitle')} message={$t('settings.factoryReset.confirmMessage')} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" defaultButton="cancel" {position} onConfirm={confirmReset} onBack={cancelReset} />
{/if}
