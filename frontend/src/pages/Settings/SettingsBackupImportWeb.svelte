<script lang="ts">
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { api } from '../../scripts/api.ts';
	import ImportWebForm from '../../components/Import/ImportWebForm.svelte';
	import SettingsBackupImportConfirm from './SettingsBackupImportConfirm.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
		onImport?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack, onImport }: Props = $props();

	type BackupData = Record<string, unknown>;

	function parseURL(url: string): Promise<BackupData> {
		return api.settings.parseFromURL(url);
	}

	function handleConfirmDone(): void {
		onImport?.();
		onBack?.();
		onBack?.();
	}
</script>

<ImportWebForm {areaID} {position} {onBack} {parseURL} onConfirmDone={handleConfirmDone}>
	{#snippet confirm({ data, onDone })}
		<SettingsBackupImportConfirm data={data as BackupData} {position} {onDone} />
	{/snippet}
</ImportWebForm>
