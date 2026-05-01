<script lang="ts">
	import { tt } from '../../scripts/language.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { joinPath } from '../../scripts/fileBrowser.ts';
	import { api } from '../../scripts/api.ts';
	import { storageBackupPath, defaultCompress } from '../../scripts/settings.ts';
	import ExportFileForm, { type ExportOptions } from '../../components/Export/ExportFileForm.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();

	function generateFileName(): string {
		const now = new Date();
		const ts = now.getFullYear().toString() + '-' + (now.getMonth() + 1).toString().padStart(2, '0') + '-' + now.getDate().toString().padStart(2, '0') + '_' + now.getHours().toString().padStart(2, '0') + now.getMinutes().toString().padStart(2, '0') + now.getSeconds().toString().padStart(2, '0');
		return `settings_${ts}.lishset`;
	}

	const initialFileName = generateFileName();
	let filePath = $state(joinPath($storageBackupPath, $defaultCompress ? initialFileName + '.gz' : initialFileName));

	async function doExport(path: string, opts: ExportOptions): Promise<{ success: boolean }> {
		return await api.settings.exportToFile(path, opts.minifyJSON, opts.compress);
	}

	function onSuccess(): void {
		addNotification(tt('settings.backup.exported'), 'success');
		onBack?.();
	}
</script>

<ExportFileForm {areaID} {position} {onBack} bind:filePath defaultDirectory={$storageBackupPath} extension="lishset" fallbackFileName={generateFileName()} {doExport} {onSuccess} />
