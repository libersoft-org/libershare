<script lang="ts">
	import { t, tt, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { type IdentityBackup } from '@shared';
	import { api } from '../../scripts/api.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import ConfirmDialog from '../../components/Dialog/ConfirmDialog.svelte';
	interface Props {
		data: IdentityBackup;
		currentPeerID: string;
		position: Position;
		onDone: () => void;
	}
	let { data, currentPeerID, position, onDone }: Props = $props();
	let message = $derived(tt('settings.identity.confirmImport', { current: currentPeerID, next: data.peerID }));

	async function handleConfirm(): Promise<void> {
		try {
			await api.identity.applyImported(data.privateKey);
			addNotification(tt('settings.identity.imported'), 'success');
		} catch (e) {
			addNotification(translateError(e), 'error');
		}
		onDone();
	}

	function handleCancel(): void {
		onDone();
	}
</script>

<ConfirmDialog title={$t('settings.identity.importTitle')} {message} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" defaultButton="cancel" {position} onConfirm={handleConfirm} onBack={handleCancel} />
