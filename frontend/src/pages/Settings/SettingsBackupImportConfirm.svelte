<script lang="ts">
	import { onMount } from 'svelte';
	import { t, tt, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { api } from '../../scripts/api.ts';
	import { loadSettings } from '../../scripts/settings.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import ConfirmDialog from '../../components/Dialog/ConfirmDialog.svelte';
	interface Props {
		data: Record<string, unknown>;
		position: Position;
		onDone: () => void;
	}
	let { data, position, onDone }: Props = $props();

	async function handleConfirm(): Promise<void> {
		try {
			const result = await api.settings.applyImported(data);
			await loadSettings();
			addNotification(tt('settings.backup.restored', { count: String(result.applied) }), 'success');
			addNotification(tt('settings.backup.restartHint'), 'warning');
		} catch (e) {
			addNotification(translateError(e), 'error');
		}
		onDone();
	}

	function handleCancel(): void {
		onDone();
	}

	onMount(() => {});
</script>

<ConfirmDialog title={$t('settings.backup.importTitle')} message={$t('settings.backup.confirmRestore')} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={handleConfirm} onBack={handleCancel} />
