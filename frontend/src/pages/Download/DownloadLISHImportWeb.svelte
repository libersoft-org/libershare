<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { navigateBack } from '../../scripts/navigation.ts';
	import { storagePath, autoStartSharing, autoStartDownloading } from '../../scripts/settings.ts';
	import { api } from '../../scripts/api.ts';
	import { type ILISH } from '@shared';
	import ImportWebForm from '../../components/Import/ImportWebForm.svelte';
	import ImportOverwrite from './DownloadLISHImportOverwrite.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
		onImport?: (() => void) | undefined;
	}
	let { areaID, position = CONTENT_POSITIONS.main, onBack, onImport }: Props = $props();
	let downloadPath = $state($storagePath);

	function parseURL(url: string): Promise<ILISH[]> {
		return api.lishs.parseFromURL(url);
	}

	function handleConfirmDone(): void {
		if (onImport) onImport();
		else {
			navigateBack();
			navigateBack();
		}
	}
</script>

<ImportWebForm {areaID} {position} {onBack} {parseURL} urlLabel={$t('lish.import.url')} bind:downloadPath downloadPathLabel={$t('lish.import.downloadPath')} onConfirmDone={handleConfirmDone}>
	{#snippet confirm({ data, onDone })}
		<ImportOverwrite lishs={data as ILISH[]} {downloadPath} {position} enableSharing={$autoStartSharing} enableDownloading={$autoStartDownloading} {onDone} />
	{/snippet}
</ImportWebForm>
