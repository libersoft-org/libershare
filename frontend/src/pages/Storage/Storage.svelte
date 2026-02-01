<script lang="ts">
	import { tick } from 'svelte';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	import DownloadLISHImportJSON from '../Download/DownloadLISHImportJSON.svelte';
	import SettingsLISHNetworkImportJSON from '../Settings/SettingsLISHNetworkImportJSON.svelte';
	import { storagePath } from '../../scripts/settings.ts';
	import { t } from '../../scripts/language.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	interface Props {
		areaID: string;
		position?: Position;
		onBack?: () => void;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();
	// Special file import state
	let importMode = $state<'lish' | 'lishnet' | null>(null);
	let importFilePath = $state('');

	function handleOpenSpecialFile(path: string, type: 'lish' | 'lishnet') {
		importFilePath = path;
		importMode = type;
		if (type === 'lish') pushBreadcrumb($t('common.import') + ' LISH');
		else pushBreadcrumb($t('common.import') + ' LISHNET');
	}

	async function handleImportBack() {
		popBreadcrumb();
		importMode = null;
		importFilePath = '';
		await tick();
	}

	function handleImportComplete() {
		popBreadcrumb();
		importMode = null;
		importFilePath = '';
	}
</script>

{#if importMode === 'lish'}
	<DownloadLISHImportJSON {areaID} {position} initialFilePath={importFilePath} onBack={handleImportBack} onImport={handleImportComplete} />
{:else if importMode === 'lishnet'}
	<SettingsLISHNetworkImportJSON {areaID} {position} initialFilePath={importFilePath} onBack={handleImportBack} onImport={handleImportComplete} />
{:else}
	<FileBrowser {areaID} {position} {onBack} initialPath={$storagePath} onOpenSpecialFile={handleOpenSpecialFile} />
{/if}
