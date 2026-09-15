<script lang="ts">
	import { tt } from '../../scripts/language.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { joinPath } from '../../scripts/fileBrowser.ts';
	import { api } from '../../scripts/api.ts';
	import { storageBackupPath, defaultCompress, defaultCompressionAlgorithm } from '../../scripts/settings.ts';
	import { compressionExtension } from '@shared';
	import ExportFileForm, { type ExportOptions } from '../../components/Export/ExportFileForm.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();
	let peerID = $state('');

	function generateFileName(id: string): string {
		const base = id ? `identity_${id}.lishid` : 'identity.lishid';
		return $defaultCompress ? base + compressionExtension($defaultCompressionAlgorithm) : base;
	}

	let filePath = $state(joinPath($storageBackupPath, generateFileName('')));

	async function loadPeerID(): Promise<void> {
		try {
			const info = await api.identity.get();
			peerID = info.peerID;
			filePath = joinPath($storageBackupPath, generateFileName(peerID));
		} catch {
			// Keep default name; user can rename it
		}
	}

	void loadPeerID();

	async function doExport(path: string, opts: ExportOptions): Promise<{ success: boolean }> {
		return await api.identity.exportToFile(path, opts.minifyJSON, opts.compress, opts.compressionAlgorithm);
	}

	function onSuccess(): void {
		addNotification(tt('settings.identity.exported'), 'success');
		onBack?.();
	}
</script>

<ExportFileForm {areaID} {position} {onBack} bind:filePath defaultDirectory={$storageBackupPath} extension="lishid" fallbackFileName={generateFileName(peerID)} {doExport} {onSuccess} />
