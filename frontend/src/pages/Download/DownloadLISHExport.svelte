<script lang="ts">
	import { t, tt } from '../../scripts/language.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { joinPath } from '../../scripts/fileBrowser.ts';
	import { api } from '../../scripts/api.ts';
	import { storageLISHPath, defaultCompress } from '../../scripts/settings.ts';
	import { sanitizeFilename } from '@shared';
	import ExportFileForm, { type ExportOptions } from '../../components/Export/ExportFileForm.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		lish?: { id: string; name: string } | null | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, lish = null, onBack }: Props = $props();

	function getInitialFileName(): string {
		const baseName = lish ? sanitizeFilename(lish.name || lish.id) : 'export';
		const base = `${baseName}.lish`;
		return $defaultCompress ? base + '.gz' : base;
	}

	let filePath = $state(joinPath($storageLISHPath, getInitialFileName()));

	function validate(): string | null {
		if (!lish) return $t('lish.export.errorIDRequired');
		return null;
	}

	async function doExport(path: string, opts: ExportOptions): Promise<{ success: boolean }> {
		if (!lish) return { success: false };
		return await api.lishs.exportToFile(lish.id, path, opts.minifyJSON, opts.compress);
	}

	function onSuccess(): void {
		if (!lish) return;
		addNotification(tt('downloads.lishExported', { name: lish.name || lish.id }), 'success');
		onBack?.();
	}
</script>

<ExportFileForm {areaID} {position} {onBack} bind:filePath defaultDirectory={$storageLISHPath} extension="lish" fallbackFileName={getInitialFileName()} {validate} {doExport} {onSuccess} />
