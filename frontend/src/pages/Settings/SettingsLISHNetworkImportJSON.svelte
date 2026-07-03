<script lang="ts">
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { api } from '../../scripts/api.ts';
	import { type LISHNetworkDefinition } from '@shared';
	import ImportJSONForm from '../../components/Import/ImportJSONForm.svelte';
	import ImportOverwrite from './SettingsLISHNetworkImportOverwrite.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		initialFilePath?: string | undefined;
		onBack?: (() => void) | undefined;
		onImport?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, initialFilePath = '', onBack, onImport }: Props = $props();

	function parseJSON(content: string): Promise<LISHNetworkDefinition[]> {
		return api.lishnets.parseFromJSON(content);
	}

	function handleConfirmDone(): void {
		onImport?.();
		onBack?.();
		onBack?.();
	}
</script>

<ImportJSONForm {areaID} {position} {onBack} {parseJSON} placeholder={'{"networkID": "...", "name": "...", ...}'} errorEmptyKey="settings.lishNetwork.errorInvalidFormat" {initialFilePath} onConfirmDone={handleConfirmDone}>
	{#snippet confirm({ data, onDone })}
		<ImportOverwrite networks={data as LISHNetworkDefinition[]} {position} {onDone} />
	{/snippet}
</ImportJSONForm>
