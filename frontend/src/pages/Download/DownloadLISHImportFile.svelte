<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { navigateBack } from '../../scripts/navigation.ts';
	import { storagePath, storageLISHPath, autoStartSharing, autoStartDownloading } from '../../scripts/settings.ts';
	import { api } from '../../scripts/api.ts';
	import { type ILISH } from '@shared';
	import ImportFileForm from '../../components/Import/ImportFileForm.svelte';
	import ImportOverwrite from './DownloadLISHImportOverwrite.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
		onImport?: (() => void) | undefined;
	}
	let { areaID, position = CONTENT_POSITIONS.main, onBack, onImport }: Props = $props();
	let downloadPath = $state($storagePath);

	function parseFile(path: string): Promise<ILISH[]> {
		return api.lishs.parseFromFile(path);
	}

	function parseJSON(content: string): Promise<ILISH[]> {
		return api.lishs.parseFromJSON(content);
	}

	function handleConfirmDone(): void {
		if (onImport) onImport();
		else {
			navigateBack();
			navigateBack();
		}
	}
</script>

<ImportFileForm {areaID} {position} {onBack} defaultDirectory={$storageLISHPath} fileFilter={['*.lish', '*.lishs', '*.json', '*.lish.gz', '*.lishs.gz', '*.json.gz', '*.lish.gzip', '*.lishs.gzip', '*.json.gzip']} fileFilterName={'LISH ' + $t('common.extensions')} filePathLabel={$t('lish.import.filePath')} {parseFile} {parseJSON} bind:downloadPath downloadPathLabel={$t('lish.import.downloadPath')} onConfirmDone={handleConfirmDone}>
	{#snippet confirm({ data, onDone })}
		<ImportOverwrite lishs={data as ILISH[]} {downloadPath} {position} enableSharing={$autoStartSharing} enableDownloading={$autoStartDownloading} {onDone} />
	{/snippet}
</ImportFileForm>
