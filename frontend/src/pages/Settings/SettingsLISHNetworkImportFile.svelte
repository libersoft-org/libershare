<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { storageLISHnetPath } from '../../scripts/settings.ts';
	import { api } from '../../scripts/api.ts';
	import { withCompressionExtensions, type LISHNetworkDefinition } from '@shared';
	import ImportFileForm from '../../components/Import/ImportFileForm.svelte';
	import ImportOverwrite from './SettingsLISHNetworkImportOverwrite.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
		onImport?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack, onImport }: Props = $props();

	function parseFile(path: string): Promise<LISHNetworkDefinition[]> {
		return api.lishnets.parseFromFile(path);
	}

	function handleConfirmDone(): void {
		onImport?.();
		onBack?.();
		onBack?.();
	}
</script>

<ImportFileForm {areaID} {position} {onBack} defaultDirectory={$storageLISHnetPath} fileFilter={withCompressionExtensions(['*.lishnet', '*.lishnets', '*.json'])} fileFilterName={'LISHNET ' + $t('common.extensions')} filePathLabel={$t('settings.lishNetworkImport.filePath')} {parseFile} onConfirmDone={handleConfirmDone}>
	{#snippet confirm({ data, onDone })}
		<ImportOverwrite networks={data as LISHNetworkDefinition[]} {position} {onDone} />
	{/snippet}
</ImportFileForm>
