<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { storageBackupPath } from '../../scripts/settings.ts';
	import { api } from '../../scripts/api.ts';
	import { withCompressionExtensions, type IdentityBackup } from '@shared';
	import ImportFileForm from '../../components/Import/ImportFileForm.svelte';
	import SettingsIdentityImportConfirm from './SettingsIdentityImportConfirm.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
		onImport?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack, onImport }: Props = $props();
	let currentPeerID = $state('');

	/** The confirm step shows what the current identity is being replaced with. */
	async function rememberCurrentPeerID(): Promise<void> {
		const cur = await api.identity.get();
		currentPeerID = cur.peerID;
	}

	async function parseFile(path: string): Promise<IdentityBackup> {
		await rememberCurrentPeerID();
		return await api.identity.parseFromFile(path);
	}

	async function parseUpload(uploadID: string): Promise<IdentityBackup> {
		await rememberCurrentPeerID();
		return await api.identity.parseFromUpload(uploadID);
	}

	function handleConfirmDone(): void {
		onImport?.();
		onBack?.();
		onBack?.();
	}
</script>

<ImportFileForm {areaID} {position} {onBack} defaultDirectory={$storageBackupPath} fileFilter={withCompressionExtensions(['*.lishid', '*.json'])} fileFilterName={'LISHID ' + $t('common.extensions')} {parseFile} {parseUpload} onConfirmDone={handleConfirmDone}>
	{#snippet confirm({ data, onDone })}
		<SettingsIdentityImportConfirm data={data as IdentityBackup} {currentPeerID} {position} {onDone} />
	{/snippet}
</ImportFileForm>
