<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { navigateBack } from '../../scripts/navigation.ts';
	import { storagePath, autoStartSharing, autoStartDownloading } from '../../scripts/settings.ts';
	import { api } from '../../scripts/api.ts';
	import { type ILISH } from '@shared';
	import ImportJSONForm from '../../components/Import/ImportJSONForm.svelte';
	import ImportOverwrite from './DownloadLISHImportOverwrite.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		initialFilePath?: string | undefined;
		onBack?: (() => void) | undefined;
		onImport?: (() => void) | undefined;
	}
	let { areaID, position = CONTENT_POSITIONS.main, initialFilePath = '', onBack, onImport }: Props = $props();
	let downloadPath = $state($storagePath);

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

<ImportJSONForm {areaID} {position} {onBack} {parseJSON} jsonLabel={$t('lish.import.lishJSON')} placeholder={$t('lish.import.placeholder')} errorEmptyKey="lish.import.jsonRequired" {initialFilePath} bind:downloadPath downloadPathLabel={$t('lish.import.downloadPath')} onConfirmDone={handleConfirmDone}>
	{#snippet confirm({ data, onDone })}
		<ImportOverwrite lishs={data as ILISH[]} {downloadPath} {position} enableSharing={$autoStartSharing} enableDownloading={$autoStartDownloading} {onDone} />
	{/snippet}
</ImportJSONForm>
