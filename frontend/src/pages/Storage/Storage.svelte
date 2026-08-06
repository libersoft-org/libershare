<script lang="ts">
	import { tick } from 'svelte';
	import { type Component } from 'svelte';
	import { storagePath } from '../../scripts/settings.ts';
	import { tt } from '../../scripts/language.ts';
	import { pushBreadcrumb, popBreadcrumb, navigateToAbsolutePath } from '../../scripts/navigation.ts';
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
		/** Override the file-browser start directory — set when returning from Create LISH so the user lands back where they were. Falls back to the configured storage path. */
		initialPath?: string | undefined;
		/** Name of the file to re-select in {@link initialPath} — the file the user shared, so Back lands on it highlighted. */
		initialFile?: string | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack, initialPath, initialFile }: Props = $props();
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
		onOpen: (path: string): void => {
			importFilePath = path;
			importMode = t.mode;
			pushBreadcrumb(tt('common.import') + ' ' + t.label);
		},
	}));

	// Open the Create LISH page with the chosen storage path prefilled as the data source.
	// Pass backPathIDs so that Back in Create LISH returns here instead of to the Downloads page,
	// and backInitialPath (the directory being browsed) so it lands back on that folder, not the default.
	function handleShare(sharePath: string, browseDir: string): void {
		// For a file share, remember the file name so Back re-selects it; a directory share has no specific file to highlight.
		const backInitialFile = sharePath !== browseDir ? sharePath.split(/[\\/]/).filter(Boolean).pop() : undefined;
		navigateToAbsolutePath(['downloads', 'create-lish'], { initialDataPath: sharePath, backPathIDs: ['localStorage'], backInitialPath: browseDir, backInitialFile });
	}

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
	<FileBrowser {areaID} {position} {onBack} initialPath={initialPath ?? $storagePath} {initialFile} {specialFileTypes} onShare={handleShare} />
{/if}
