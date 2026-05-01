<script lang="ts">
	import { tick } from 'svelte';
	import { type Component } from 'svelte';
	import { storagePath } from '../../scripts/settings.ts';
	import { tt } from '../../scripts/language.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import FileBrowser from '../FileBrowser/FileBrowser.svelte';
	import DownloadLISHImportJSON from '../Download/DownloadLISHImportJSON.svelte';
	import SettingsLISHNetworkImportJSON from '../Settings/SettingsLISHNetworkImportJSON.svelte';
	import SettingsBackupImportJSON from '../Settings/SettingsBackupImportJSON.svelte';
	import SettingsIdentityImportJSON from '../Settings/SettingsIdentityImportJSON.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();
	const SPECIAL_FILE_TYPES = [
		{
			mode: 'lish',
			label: 'LISH',
			extensions: ['.lish', '.lishs', '.lish.gz', '.lishs.gz', '.lish.gzip', '.lishs.gzip'],
			component: DownloadLISHImportJSON,
		},
		{
			mode: 'lishnet',
			label: 'LISHNET',
			extensions: ['.lishnet', '.lishnets', '.lishnet.gz', '.lishnets.gz', '.lishnet.gzip', '.lishnets.gzip'],
			component: SettingsLISHNetworkImportJSON,
		},
		{
			mode: 'lishset',
			label: 'LISHSET',
			extensions: ['.lishset', '.lishset.gz', '.lishset.gzip'],
			component: SettingsBackupImportJSON,
		},
		{
			mode: 'lishid',
			label: 'LISHID',
			extensions: ['.lishid', '.lishid.gz', '.lishid.gzip'],
			component: SettingsIdentityImportJSON,
		},
	] as const;
	let importMode = $state<string | null>(null);
	let importFilePath = $state('');
	let ImportComponent = $derived(SPECIAL_FILE_TYPES.find(t => t.mode === importMode)?.component as Component<any> | undefined);

	const specialFileTypes = SPECIAL_FILE_TYPES.map(t => ({
		extensions: t.extensions as unknown as string[],
		onOpen: (path: string) => {
			importFilePath = path;
			importMode = t.mode;
			pushBreadcrumb(tt('common.import') + ' ' + t.label);
		},
	}));

	async function handleImportBack(): Promise<void> {
		popBreadcrumb();
		importMode = null;
		importFilePath = '';
		await tick();
	}

	function handleImportComplete(): void {
		popBreadcrumb();
		importMode = null;
		importFilePath = '';
	}
</script>

{#if ImportComponent}
	<ImportComponent {areaID} {position} initialFilePath={importFilePath} onBack={handleImportBack} onImport={handleImportComplete} />
{:else}
	<FileBrowser {areaID} {position} {onBack} initialPath={$storagePath} {specialFileTypes} />
{/if}
