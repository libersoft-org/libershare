<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { useArea, activateArea, activeArea } from '../../scripts/areas.ts';
	import type { Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_OFFSETS } from '../../scripts/navigationLayout.ts';
	import { t } from '../../scripts/language.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { getParentPath, loadDirectoryFromApi, createParentEntry, isAtRoot, getCurrentDirName, buildFolderActions, buildFilterActions, deleteFileOrFolder, createFolder, openFile, getFileSystemInfo, joinPathWithSeparator, type LoadDirectoryOptions } from '../../scripts/fileBrowser.ts';
	import { scrollToElement } from '../../scripts/utils.ts';
	import Button from '../Buttons/Button.svelte';
	import Table from '../Table/Table.svelte';
	import Header from '../Table/TableHeader.svelte';
	import Cell from '../Table/TableCell.svelte';
	import StorageItem from '../Storage/StorageItem.svelte';
	import type { StorageItemType, StorageItemData } from '../../scripts/storage.ts';
	import Alert from '../Alert/Alert.svelte';
	import Spinner from '../Spinner/Spinner.svelte';
	import PathBreadcrumb from './FileBrowserBreadcrumb.svelte';
	import ConfirmDialog from '../Dialog/ConfirmDialog.svelte';
	import InputDialog from '../Dialog/InputDialog.svelte';
	interface Props {
		areaID: string;
		position: Position;
		initialPath?: string;
		foldersOnly?: boolean;
		filesOnly?: boolean;
		fileFilter?: string[]; // Array of extensions like ['.lish', '.json'] or ['*'] for all
		showPath?: boolean;
		onBack?: () => void;
		onSelect?: (path: string) => void;
		onDownAtEnd?: () => boolean;
	}
	const columns = '1fr 8vw 12vw';
	let { areaID, position, initialPath = '', foldersOnly = false, filesOnly = false, fileFilter, showPath = true, onBack, onSelect, onDownAtEnd }: Props = $props();

	// File filter state
	let showAllFiles = $state(false);
	let customFilter = $state<string | null>(null);
	let activeFilter = $derived(customFilter ? [customFilter] : (showAllFiles ? ['*'] : fileFilter));
	// Calculate sub-area positions based on base position
	const pathBreadcrumbPosition = { x: position.x + CONTENT_OFFSETS.pathBreadcrumb.x, y: position.y + CONTENT_OFFSETS.pathBreadcrumb.y };
	const folderActionsPosition = { x: position.x + CONTENT_OFFSETS.top.x, y: position.y + CONTENT_OFFSETS.top.y };
	const listPosition = { x: position.x + CONTENT_OFFSETS.main.x, y: position.y + CONTENT_OFFSETS.main.y };
	const actionsPosition = { x: position.x + CONTENT_OFFSETS.side.x, y: position.y + CONTENT_OFFSETS.side.y };
	const listAreaID = `${areaID}-list`;
	let active = $derived($activeArea === listAreaID);
	let actionsActive = $derived($activeArea === `${areaID}-actions`);
	let filterActive = $derived($activeArea === `${areaID}-filter`);
	let selectedIndex = $state(0);
	let selectedActionIndex = $state(0);
	let selectedFilterIndex = $state(0);
	let showActions = $state(false);
	let showFilterPanel = $state(false);
	let itemElements: HTMLElement[] = $state([]);
	let currentPath = $state<string>('');
	let parentPath = $state<string | null>(null);
	let items = $state<StorageItemData[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let separator = $state('/');
	let pathBreadcrumb: ReturnType<typeof PathBreadcrumb> | undefined = $state();
	let showDeleteConfirm = $state(false);
	let showNewFolderDialogState = $state(false);
	let showDeleteFileConfirm = $state(false);
	let fileToDelete = $state<StorageItemData | null>(null);
	let unregisterFolderActions: (() => void) | null = null;
	let unregisterList: (() => void) | null = null;
	let unregisterActions: (() => void) | null = null;
	let unregisterFilter: (() => void) | null = null;
	let selectedItem = $derived(items[selectedIndex]);
	let isEmpty = $derived(items.length === 0 || (items.length === 1 && items[0].name === '..'));
	// Format filter for display
	let filterLabel = $derived.by(() => {
		if (customFilter) return customFilter;
		if (!fileFilter || fileFilter.length === 0) return null;
		if (showAllFiles) return '*.*';
		return fileFilter.join(', ');
	});
	// Folder toolbar actions
	let folderActions = $derived(buildFolderActions($t, filesOnly, showAllFiles, fileFilter, !!onSelect, customFilter ?? undefined));
	let selectedFolderActionIndex = $state(0);
	let folderActionsActive = $derived($activeArea === `${areaID}-folder-actions`);
	// Filter panel actions
	let filterActions = $derived(buildFilterActions($t, fileFilter, customFilter ?? undefined));
	let showCustomFilterDialog = $state(false);

	async function loadDirectory(path?: string, selectName?: string): Promise<void> {
		loading = true;
		error = null;
		// Set the intended path immediately so it's visible during loading
		if (path) {
			currentPath = path;
			parentPath = getParentPath(path, separator);
		}
		try {
			const options: LoadDirectoryOptions = { foldersOnly, filesOnly, fileFilter: activeFilter };
			const result = await loadDirectoryFromApi(path, separator, options);
			currentPath = result.path;
			parentPath = result.parentPath;
			items = result.items;
			// Select specific item by name, or default to first
			if (selectName) {
				const idx = result.items.findIndex(e => e.name === selectName);
				selectedIndex = idx >= 0 ? idx : 0;
			} else selectedIndex = 0;
		} catch (e: any) {
			error = e.message || 'Failed to load directory';
			// Even on error, provide ".." entry to navigate up if we have a parent path
			// Don't show ".." at root level (Linux "/" or empty path, Windows drive list)
			if (!isAtRoot(currentPath, separator) && parentPath !== null) {
				items = [createParentEntry(parentPath)];
				selectedIndex = 0;
			} else items = [];
		} finally {
			loading = false;
		}
	}

	const scrollToSelected = () => scrollToElement(itemElements, selectedIndex);

	async function navigateInto(item: StorageItemData): Promise<void> {
		if (item.type === 'folder' || item.type === 'drive') {
			// If navigating to "..", select the folder we came from
			if (item.name === '..') {
				const currentName = getCurrentDirName(currentPath, separator);
				await loadDirectory(item.path, currentName);
			} else await loadDirectory(item.path);
		}
	}

	async function navigateUp(): Promise<void> {
		if (parentPath !== null) {
			// Get current directory name to select after going up
			const currentName = getCurrentDirName(currentPath, separator);
			await loadDirectory(parentPath || undefined, currentName);
		}
	}

	function openActions(): void {
		showActions = true;
		selectedActionIndex = 0;
		activateArea(`${areaID}-actions`);
	}

	const areaHandlers = {
		up: () => {
			if (selectedIndex > 0) {
				selectedIndex--;
				showActions = false; // Hide actions when selection changes
				scrollToSelected();
				return true;
			}
			// At top of list, switch to folder actions toolbar (or path breadcrumb if error)
			if (error) {
				if (showPath) activateArea(`${areaID}-path`);
				else return false;
			} else activateArea(`${areaID}-folder-actions`);
			return true;
		},
		down: () => {
			if (selectedIndex < items.length - 1) {
				selectedIndex++;
				showActions = false; // Hide actions when selection changes
				scrollToSelected();
				return true;
			}
			if (onDownAtEnd) return onDownAtEnd();
			return false; // Allow navigation to other areas
		},
		left: () => false, // Allow navigation to other areas
		right: () => !showActions, // Allow navigation to actions panel only when it's visible
		confirmDown: () => {},
		confirmUp: () => {
			const item = items[selectedIndex];
			if (item && (item.type === 'folder' || item.type === 'drive'))
				navigateInto(item); // Folders/drives - navigate into them
			else if (item?.type === 'file') {
				// Files - in filesOnly mode, select the file directly
				if (filesOnly) onSelect?.(item.path);
				else openActions(); // Otherwise show actions panel
			}
		},
		confirmCancel: () => {},
		back: () => {
			if (parentPath !== null) navigateUp();
			else onBack?.();
		},
	};

	const folderActionsAreaHandlers = {
		up: () => {
			// Go to path breadcrumb if available
			if (showPath) {
				activateArea(`${areaID}-path`);
				return true;
			}
			// Otherwise let areaNavigate handle it (go to global breadcrumb)
			return false;
		},
		down: () => {
			// Go to file list
			activateArea(listAreaID);
			return true;
		},
		left: () => {
			if (selectedFolderActionIndex > 0) {
				selectedFolderActionIndex--;
				return true;
			}
			return false;
		},
		right: () => {
			if (selectedFolderActionIndex < folderActions.length - 1) {
				selectedFolderActionIndex++;
				return true;
			}
			return false;
		},
		confirmDown: () => {},
		confirmUp: () => {
			const action = folderActions[selectedFolderActionIndex];
			if (action) handleFolderAction(action.id);
		},
		confirmCancel: () => {},
		back: () => {
			if (parentPath !== null) navigateUp();
			else onBack?.();
		},
	};

	// File actions: open, delete, back
	const fileActions = [
		{ id: 'open', label: $t.fileBrowser?.openFile, icon: '/img/folder.svg' },
		{ id: 'delete', label: $t.fileBrowser?.deleteFile, icon: '/img/del.svg' },
		{ id: 'back', label: $t.common?.back, icon: '/img/back.svg' },
	];

	const actionsAreaHandlers = {
		up: () => {
			if (selectedActionIndex > 0) {
				selectedActionIndex--;
				return true;
			}
			return false;
		},
		down: () => {
			if (selectedActionIndex < fileActions.length - 1) {
				selectedActionIndex++;
				return true;
			}
			return false;
		},
		left: () => false,
		right: () => false,
		confirmDown: () => {},
		confirmUp: () => {
			const action = fileActions[selectedActionIndex];
			if (action) handleAction(action.id);
		},
		confirmCancel: () => {},
		back: () => {
			showActions = false;
			activateArea(listAreaID);
		},
	};

	const filterAreaHandlers = {
		up: () => {
			if (selectedFilterIndex > 0) {
				selectedFilterIndex--;
				return true;
			}
			return false;
		},
		down: () => {
			if (selectedFilterIndex < filterActions.length - 1) {
				selectedFilterIndex++;
				return true;
			}
			return false;
		},
		left: () => false,
		right: () => false,
		confirmDown: () => {},
		confirmUp: () => {
			const action = filterActions[selectedFilterIndex];
			if (action) handleFilterAction(action.id);
		},
		confirmCancel: () => {},
		back: () => closeFilterPanel(),
	};

	function handleAction(actionId: string) {
		const item = items[selectedIndex];
		if (!item || item.type !== 'file') return;
		switch (actionId) {
			case 'open':
				handleOpenFile(item);
				break;
			case 'delete':
				showDeleteFileConfirmDialog(item);
				return; // Don't close actions panel yet
			case 'back':
				break;
		}
		showActions = false;
		activateArea(listAreaID);
	}

	function handleFolderAction(actionId: string) {
		switch (actionId) {
			case 'select':
				onSelect?.(currentPath);
				break;
			case 'new':
				showNewFolderDialog();
				break;
			case 'delete':
				showDeleteConfirmDialog();
				break;
			case 'filter':
				openFilterPanel();
				break;
		}
	}

	function openFilterPanel() {
		showFilterPanel = true;
		selectedFilterIndex = 0;
		// Find current filter in the list to pre-select it
		if (showAllFiles) {
			const allIdx = filterActions.findIndex(a => a.id === '*');
			if (allIdx >= 0) selectedFilterIndex = allIdx;
		} else if (fileFilter && fileFilter.length > 0) selectedFilterIndex = 0; // Select first filter option
		unregisterFilter = useArea(`${areaID}-filter`, filterAreaHandlers, actionsPosition);
		activateArea(`${areaID}-filter`);
	}

	function closeFilterPanel() {
		showFilterPanel = false;
		if (unregisterFilter) {
			unregisterFilter();
			unregisterFilter = null;
		}
		activateArea(`${areaID}-folder-actions`);
	}

	function handleFilterAction(actionId: string) {
		if (actionId === 'back') {
			closeFilterPanel();
			return;
		}
		if (actionId === 'custom') {
			openCustomFilterDialog();
			return;
		}
		// Set the filter
		if (actionId === '*') {
			showAllFiles = true;
			customFilter = null;
		} else if (actionId === 'filter') {
			showAllFiles = false;
			customFilter = null;
		}
		loadDirectory(currentPath);
		closeFilterPanel();
	}

	function openCustomFilterDialog() {
		showCustomFilterDialog = true;
		if (unregisterFilter) {
			unregisterFilter();
			unregisterFilter = null;
		}
		pushBreadcrumb($t.fileBrowser?.customFilter);
	}

	function closeCustomFilterDialog() {
		showCustomFilterDialog = false;
		popBreadcrumb();
		unregisterFilter = useArea(`${areaID}-filter`, filterAreaHandlers, actionsPosition);
		tick().then(() => activateArea(`${areaID}-filter`));
	}

	function confirmCustomFilter(value: string) {
		customFilter = value.trim();
		showAllFiles = false;
		showCustomFilterDialog = false;
		popBreadcrumb();
		loadDirectory(currentPath);
		closeFilterPanel();
	}

	function showDeleteConfirmDialog() {
		showDeleteConfirm = true;
		// Unregister areas so dialog can take over
		if (unregisterFolderActions) {
			unregisterFolderActions();
			unregisterFolderActions = null;
		}
		if (unregisterList) {
			unregisterList();
			unregisterList = null;
		}
		if (unregisterActions) {
			unregisterActions();
			unregisterActions = null;
		}
		pushBreadcrumb($t.common?.delete);
	}

	async function confirmDeleteFolder() {
		const result = await deleteFileOrFolder(currentPath);
		if (result.success) {
			if (parentPath !== null) await loadDirectory(parentPath); // Navigate to parent after deletion
		} else error = result.error || 'Failed to delete folder';
		cancelDeleteFolder();
	}

	async function cancelDeleteFolder() {
		showDeleteConfirm = false;
		popBreadcrumb();
		await tick();
		// Re-register all areas
		unregisterFolderActions = useArea(`${areaID}-folder-actions`, folderActionsAreaHandlers, folderActionsPosition);
		unregisterList = useArea(`${areaID}-list`, areaHandlers, listPosition);
		unregisterActions = useArea(`${areaID}-actions`, actionsAreaHandlers, actionsPosition);
		activateArea(`${areaID}-folder-actions`);
	}

	function showNewFolderDialog() {
		showNewFolderDialogState = true;
		// Unregister areas so dialog can take over
		if (unregisterFolderActions) {
			unregisterFolderActions();
			unregisterFolderActions = null;
		}
		if (unregisterList) {
			unregisterList();
			unregisterList = null;
		}
		if (unregisterActions) {
			unregisterActions();
			unregisterActions = null;
		}
		pushBreadcrumb($t.fileBrowser?.newFolder);
	}

	async function confirmNewFolder(folderName: string) {
		const newPath = joinPathWithSeparator(currentPath, folderName, separator);
		const result = await createFolder(newPath);
		if (result.success) {
			// Reload directory and select the new folder
			await loadDirectory(currentPath, folderName);
			cancelNewFolder(true); // Pass true to indicate success - focus on list
		} else {
			error = result.error || 'Failed to create folder';
			cancelNewFolder(false);
		}
	}

	async function cancelNewFolder(focusList = false) {
		showNewFolderDialogState = false;
		popBreadcrumb();
		await tick();
		// Re-register all areas
		unregisterFolderActions = useArea(`${areaID}-folder-actions`, folderActionsAreaHandlers, folderActionsPosition);
		unregisterList = useArea(`${areaID}-list`, areaHandlers, listPosition);
		unregisterActions = useArea(`${areaID}-actions`, actionsAreaHandlers, actionsPosition);
		// Focus on list if folder was created successfully, otherwise on toolbar
		if (focusList) {
			activateArea(listAreaID);
		} else {
			activateArea(`${areaID}-folder-actions`);
		}
	}

	async function handleOpenFile(item: StorageItemData) {
		const result = await openFile(item.path);
		if (!result.success) {
			error = result.error || 'Failed to open file';
		}
		showActions = false;
		activateArea(listAreaID);
	}

	function showDeleteFileConfirmDialog(item: StorageItemData) {
		fileToDelete = item;
		showDeleteFileConfirm = true;
		showActions = false;
		// Unregister areas so dialog can take over
		if (unregisterFolderActions) {
			unregisterFolderActions();
			unregisterFolderActions = null;
		}
		if (unregisterList) {
			unregisterList();
			unregisterList = null;
		}
		if (unregisterActions) {
			unregisterActions();
			unregisterActions = null;
		}
		pushBreadcrumb($t.fileBrowser?.deleteFile);
	}

	async function confirmDeleteFile() {
		if (!fileToDelete) return;
		const result = await deleteFileOrFolder(fileToDelete.path);
		if (result.success) {
			// Reload directory
			await loadDirectory(currentPath);
		} else {
			error = result.error || 'Failed to delete file';
		}
		cancelDeleteFile();
	}

	async function cancelDeleteFile() {
		showDeleteFileConfirm = false;
		fileToDelete = null;
		popBreadcrumb();
		await tick();
		// Re-register all areas
		unregisterFolderActions = useArea(`${areaID}-folder-actions`, folderActionsAreaHandlers, folderActionsPosition);
		unregisterList = useArea(`${areaID}-list`, areaHandlers, listPosition);
		unregisterActions = useArea(`${areaID}-actions`, actionsAreaHandlers, actionsPosition);
		activateArea(listAreaID);
	}

	export function getCurrentPath(): string {
		return currentPath;
	}

	export function getItemElements() {
		return itemElements;
	}

	onMount(() => {
		// Register sub-areas with positions relative to content area
		unregisterFolderActions = useArea(`${areaID}-folder-actions`, folderActionsAreaHandlers, folderActionsPosition);
		unregisterList = useArea(`${areaID}-list`, areaHandlers, listPosition);
		unregisterActions = useArea(`${areaID}-actions`, actionsAreaHandlers, actionsPosition);
		activateArea(`${areaID}-list`);

		(async () => {
			try {
				const info = await getFileSystemInfo();
				separator = info.separator;
				// Resolve initial path
				let startPath = initialPath;
				if (startPath.startsWith('~')) startPath = (info.home || '') + startPath.slice(1);
				await loadDirectory(startPath || info.home || '');
			} catch (e: any) {
				error = e.message || 'Failed to initialize';
				loading = false;
			}
		})();
		return () => {
			if (unregisterFolderActions) unregisterFolderActions();
			if (unregisterList) unregisterList();
			if (unregisterActions) unregisterActions();
			if (unregisterFilter) unregisterFilter();
		};
	});
</script>

<style>
	.browser {
		display: flex;
		flex-direction: column;
		gap: 1vh;
		height: 100%;
		overflow: hidden;
	}

	.content {
		display: flex;
		gap: 2vh;
		flex: 1;
		overflow: hidden;
	}

	.container {
		flex: 1;
		margin: 0 2vh;
		border: 0.4vh solid var(--secondary-softer-background);
		border-radius: 2vh;
		overflow: hidden;
	}

	.items {
		flex: 1;
		overflow-y: auto;
		font-size: 1.4vh;
	}

	.items .loading {
		margin: 2vh;
	}

	.actions {
		display: flex;
		flex-direction: column;
		padding: 2vh;
		gap: 1vh;
		min-width: 20vh;
	}

	.folder-actions {
		display: flex;
		flex-direction: row;
		gap: 1vh;
		padding: 0 2vh;
	}
</style>

<div class="browser">
	{#if showPath}
		<PathBreadcrumb bind:this={pathBreadcrumb} areaID="{areaID}-path" position={pathBreadcrumbPosition} path={currentPath} {separator} onNavigate={path => loadDirectory(path)} onDown={() => (error ? `${areaID}-list` : `${areaID}-folder-actions`)} />
	{/if}
	{#if !error}
		<div class="folder-actions">
			{#each folderActions as action, index (action.id)}
				<Button label={action.label} icon={action.icon} selected={folderActionsActive && selectedFolderActionIndex === index} onConfirm={() => handleFolderAction(action.id)} />
			{/each}
		</div>
	{/if}
	{#if error}
		<Alert type="error" message={error} />
	{/if}
	<div class="content">
		<div class="container">
			<Table {columns} noBorder>
				<Header>
					<Cell>{$t.localStorage?.name}</Cell>
					<Cell align="right" desktopOnly>{$t.localStorage?.size}</Cell>
					<Cell align="right" desktopOnly>{$t.localStorage?.modified}</Cell>
				</Header>
				<div class="items">
					{#if loading}
						<div class="loading">
							<Spinner size="8vh" />
						</div>
					{:else if error}
						{#each items as item, index (item.id)}
							<div bind:this={itemElements[index]}>
								<StorageItem name={item.name} type={item.type} size={item.size} modified={item.modified} selected={active && selectedIndex === index} isLast={index === items.length - 1} odd={index % 2 === 0} />
							</div>
						{/each}
					{:else}
						{#each items as item, index (item.id)}
							<div bind:this={itemElements[index]}>
								<StorageItem name={item.name} type={item.type} size={item.size} modified={item.modified} selected={active && selectedIndex === index} isLast={index === items.length - 1} odd={index % 2 === 0} />
							</div>
						{/each}
					{/if}
				</div>
			</Table>
		</div>
		{#if showActions && selectedItem?.type === 'file'}
			<div class="actions">
				{#each fileActions as action, index (action.id)}
					<Button icon={action.icon} label={action.label} selected={actionsActive && selectedActionIndex === index} onConfirm={() => handleAction(action.id)} />
				{/each}
			</div>
		{/if}
		{#if showFilterPanel}
			<div class="actions">
				{#each filterActions as action, index (action.id)}
					<Button icon={action.icon} label={action.label} selected={filterActive && selectedFilterIndex === index} onConfirm={() => handleFilterAction(action.id)} />
				{/each}
			</div>
		{/if}
	</div>
</div>
{#if showDeleteConfirm}
	<ConfirmDialog title={$t.fileBrowser?.deleteFolder} message={$t.fileBrowser?.confirmDeleteFolder?.replace('{path}', currentPath)} confirmLabel={$t.common?.yes} cancelLabel={$t.common?.no} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" defaultButton="cancel" {position} onConfirm={confirmDeleteFolder} onBack={cancelDeleteFolder} />
{/if}
{#if showDeleteFileConfirm && fileToDelete}
	<ConfirmDialog title={$t.fileBrowser?.deleteFile} message={$t.fileBrowser?.confirmDeleteFile?.replace('{name}', fileToDelete.name)} confirmLabel={$t.common?.yes} cancelLabel={$t.common?.no} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" defaultButton="cancel" {position} onConfirm={confirmDeleteFile} onBack={cancelDeleteFile} />
{/if}
{#if showNewFolderDialogState}
	<InputDialog title={$t.fileBrowser?.newFolder} label={$t.fileBrowser?.folderName} placeholder={$t.fileBrowser?.enterFolderName} confirmLabel={$t.common?.create} cancelLabel={$t.common?.cancel} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmNewFolder} onBack={cancelNewFolder} />
{/if}
{#if showCustomFilterDialog}
	<InputDialog title={$t.fileBrowser?.customFilter} label={$t.fileBrowser?.filterPattern} placeholder={$t.fileBrowser?.enterFilterPattern} initialValue={customFilter ?? ''} confirmLabel={$t.common?.ok} cancelLabel={$t.common?.cancel} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmCustomFilter} onBack={closeCustomFilterDialog} />
{/if}
