<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { storageBackupPath } from '../../scripts/settings.ts';
	import { api } from '../../scripts/api.ts';
	import ImportFileForm from '../../components/Import/ImportFileForm.svelte';
	import SettingsBackupImportConfirm from './SettingsBackupImportConfirm.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
		onImport?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack, onImport }: Props = $props();

	type BackupData = Record<string, unknown>;

	function parseFile(path: string): Promise<BackupData> {
		return api.settings.parseFromFile(path);
	}

	function parseJSON(content: string): Promise<BackupData> {
		return api.settings.parseFromJSON(content);
	}

	function handleConfirmDone(): void {
		onImport?.();
		onBack?.();
		onBack?.();
	}
</script>

<ImportFileForm {areaID} {position} {onBack} defaultDirectory={$storageBackupPath} fileFilter={['*.lishset', '*.lishset.gz', '*.lishset.gzip', '*.json', '*.json.gz', '*.json.gzip']} fileFilterName={'LISHSET ' + $t('common.extensions')} {parseFile} {parseJSON} onConfirmDone={handleConfirmDone}>
	{#snippet confirm({ data, onDone })}
		<SettingsBackupImportConfirm data={data as BackupData} {position} {onDone} />
	{/snippet}
</ImportFileForm>
