<script lang="ts">
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { api } from '../../scripts/api.ts';
	import ImportJSONForm from '../../components/Import/ImportJSONForm.svelte';
	import SettingsBackupImportConfirm from './SettingsBackupImportConfirm.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
		onImport?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack, onImport }: Props = $props();

	type BackupData = Record<string, unknown>;

	function parseJSON(content: string): Promise<BackupData> {
		return api.settings.parseFromJSON(content);
	}

	function handleConfirmDone(): void {
		onImport?.();
		onBack?.();
		onBack?.();
	}
</script>

<ImportJSONForm {areaID} {position} {onBack} {parseJSON} placeholder={'{"language": "...", "ui": {...}, ...}'} errorEmptyKey="settings.backup.errorInvalidFormat" onConfirmDone={handleConfirmDone}>
	{#snippet confirm({ data, onDone })}
		<SettingsBackupImportConfirm data={data as BackupData} {position} {onDone} />
	{/snippet}
</ImportJSONForm>
