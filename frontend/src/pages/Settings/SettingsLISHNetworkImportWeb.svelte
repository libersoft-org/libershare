<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { api } from '../../scripts/api.ts';
	import { type LISHNetworkDefinition } from '@shared';
	import ImportWebForm from '../../components/Import/ImportWebForm.svelte';
	import ImportOverwrite from './SettingsLISHNetworkImportOverwrite.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
		onImport?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack, onImport }: Props = $props();

	function parseURL(url: string): Promise<LISHNetworkDefinition[]> {
		return api.lishnets.parseFromURL(url);
	}

	function handleConfirmDone(): void {
		onImport?.();
		onBack?.();
		onBack?.();
	}
</script>

<ImportWebForm {areaID} {position} {onBack} {parseURL} urlLabel={$t('settings.lishNetworkImport.url')} onConfirmDone={handleConfirmDone}>
	{#snippet confirm({ data, onDone })}
		<ImportOverwrite networks={data as LISHNetworkDefinition[]} {position} {onDone} />
	{/snippet}
</ImportWebForm>
