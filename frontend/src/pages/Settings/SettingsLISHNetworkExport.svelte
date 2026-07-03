<script lang="ts">
	import { t, tt } from '../../scripts/language.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { joinPath } from '../../scripts/fileBrowser.ts';
	import { api } from '../../scripts/api.ts';
	import { storageLISHnetPath, defaultCompress } from '../../scripts/settings.ts';
	import { sanitizeFilename } from '@shared';
	import ExportFileForm, { type ExportOptions } from '../../components/Export/ExportFileForm.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		network?: { id: string; name: string } | null | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, network = null, onBack }: Props = $props();

	function getInitialFileName(): string {
		const baseName = network ? sanitizeFilename(network.name || network.id) : 'network';
		const base = `${baseName}.lishnet`;
		return $defaultCompress ? base + '.gz' : base;
	}

	let filePath = $state(joinPath($storageLISHnetPath, getInitialFileName()));

	function validate(): string | null {
		if (!network) return $t('settings.lishNetwork.errorNetworkIDRequired');
		return null;
	}

	async function doExport(path: string, opts: ExportOptions): Promise<{ success: boolean }> {
		if (!network) return { success: false };
		return await api.lishnets.exportToFile(network.id, path, opts.minifyJSON, opts.compress);
	}

	function onSuccess(): void {
		if (!network) return;
		addNotification(tt('settings.lishNetwork.networkExported', { name: network.name || network.id }), 'success');
		onBack?.();
	}
</script>

<ExportFileForm {areaID} {position} {onBack} bind:filePath defaultDirectory={$storageLISHnetPath} extension="lishnet" fallbackFileName={getInitialFileName()} {validate} {doExport} {onSuccess} />
