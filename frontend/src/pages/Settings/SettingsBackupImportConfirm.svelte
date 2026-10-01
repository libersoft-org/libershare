<script lang="ts">
	import { onMount } from 'svelte';
	import { t, tt, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { api } from '../../scripts/api.ts';
	import { loadSettings } from '../../scripts/settings.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { CodedError, ErrorCodes, type ErrorCode, type ISettingsImportResult } from '@shared';
	import ConfirmDialog from '../../components/Dialog/ConfirmDialog.svelte';
	interface Props {
		data: Record<string, unknown>;
		position: Position;
		onDone: () => void;
	}
	let { data, position, onDone }: Props = $props();

	async function handleConfirm(): Promise<void> {
		let result: ISettingsImportResult | null = null;
		let failure: unknown;
		try {
			result = await api.settings.applyImported(data);
		} catch (error) {
			failure = error;
		}
		let refreshed = false;
		try {
			await loadSettings({ throwOnError: true });
			refreshed = true;
		} catch (error) {
			addNotification(tt('settings.backup.reloadFailed', { detail: translateError(error) }), 'error');
		}
		if (result && refreshed) addNotification(tt('settings.backup.restored', { count: String(result.applied) }), 'success');
		else if (!result) {
			if (failure instanceof Error && 'code' in failure && failure.code === ErrorCodes.SETTINGS_SAVED_NOT_APPLIED) {
				let cause = new CodedError(ErrorCodes.INTERNAL_ERROR);
				try {
					const detail = JSON.parse('detail' in failure && typeof failure.detail === 'string' ? failure.detail : '{}');
					if (typeof detail.code === 'string' && Object.hasOwn(ErrorCodes, detail.code) && (detail.detail === undefined || typeof detail.detail === 'string')) cause = new CodedError(detail.code as ErrorCode, detail.detail);
				} catch {
					/* An older or malformed reply cannot prove a more specific cause. */
				}
				addNotification(tt('settings.backup.savedNotApplied', { detail: translateError(cause) }), 'warning');
			} else addNotification(translateError(failure), 'error');
		}
		onDone();
	}

	function handleCancel(): void {
		onDone();
	}

	onMount(() => {});
</script>

<ConfirmDialog title={$t('settings.backup.importTitle')} message={$t('settings.backup.confirmRestore')} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={handleConfirm} onBack={handleCancel} />
