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
	import ConfirmDialog from '../../components/Dialog/ConfirmDialog.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();

	let busy = $state(false);
	let errorMessage = $state('');
	let showConfirm = $state(false);

	function askReset(): void {
		errorMessage = '';
		showConfirm = true;
	}

	async function confirmReset(): Promise<void> {
		showConfirm = false;
		busy = true;
		errorMessage = '';
		try {
			await api.settings.factoryReset();
			// Stash the already-translated confirmation so it can be shown after the
			// reload (the page reloads to a clean slate, so a notification raised here
			// would be discarded). Pre-translating avoids any i18n load-timing race.
			sessionStorage.setItem('factoryResetDone', tt('settings.factoryReset.done'));
			// Identity, networks, downloads and settings all changed — reload the UI
			// from a clean slate rather than reconciling every store by hand.
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
		gap: 2vh;
		overflow-y: auto;
	}

	.container {
		display: flex;
		flex-direction: column;
		gap: 1.5vh;
		width: 800px;
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
		<Alert type="warning" message={$t('settings.factoryReset.warning')} />
		{#if errorMessage}
			<Alert type="error" message={errorMessage} />
		{/if}
	</div>
	<ButtonBar justify="center" basePosition={[0, 0]}>
		<Button icon="/img/factory-reset.svg" label={busy ? $t('settings.factoryReset.resetting') : $t('settings.factoryReset.reset')} disabled={busy} onConfirm={askReset} />
		<Button icon="/img/back.svg" label={$t('common.back')} disabled={busy} onConfirm={onBack} />
	</ButtonBar>
</div>
{#if showConfirm}
	<ConfirmDialog title={$t('settings.factoryReset.confirmTitle')} message={$t('settings.factoryReset.confirmMessage')} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" defaultButton="cancel" {position} onConfirm={confirmReset} onBack={cancelReset} />
{/if}
