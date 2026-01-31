<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { useArea, activateArea, activeArea } from '../../scripts/areas.ts';
	import type { Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_OFFSETS } from '../../scripts/navigationLayout.ts';
	import { t, withDetail } from '../../scripts/language.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { api } from '../../scripts/api.ts';
	import { getParentPath, loadDirectoryFromApi, createParentEntry, isAtRoot, getCurrentDirName, buildFolderActions, buildFilterActions, deleteFileOrFolder, createFolder, openFile, renameFile, getFileSystemInfo, joinPathWithSeparator, getFileActions, type LoadDirectoryOptions } from '../../scripts/fileBrowser.ts';
	import { scrollToElement, formatSize } from '../../scripts/utils.ts';
	import Button from '../Buttons/Button.svelte';
	import Input from '../Input/Input.svelte';
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
	import Editor from '../Editor/Editor.svelte';
	interface Props {
		areaID: string;
		position: Position;
		initialPath?: string;
		initialFile?: string; // File name to select in the initial directory
		foldersOnly?: boolean;
		filesOnly?: boolean;
		fileFilter?: string[]; // Array of extensions like ['.lish', '.json'] or ['*'] for all
		showPath?: boolean;
		selectFolderButton?: boolean;
		selectFileButton?: boolean;
		saveFileName?: string; // If provided, shows a filename input for "save as" mode
		saveContent?: string; // Content to save - if provided, FileBrowser handles the save operation
		useGzip?: boolean; // If true, compress content with gzip before saving
		onBack?: () => void;
		onSelect?: (path: string) => void;
		onSaveFileNameChange?: (fileName: string) => void;
		onSaveComplete?: (path: string) => void; // Called after successful save
		onSaveError?: (error: string) => void; // Called on save error
		onDownAtEnd?: () => boolean;
		onOpenSpecialFile?: (path: string, type: 'lish' | 'lishnet') => void; // Called for .lish/.lishs/.lishnet/.lishnets files
	}
	const columns = '1fr 8vw 12vw';
	let { areaID, position, initialPath = '', initialFile, foldersOnly = false, filesOnly = false, fileFilter, showPath = true, selectFolderButton = false, selectFileButton = false, saveFileName, saveContent, useGzip = false, onBack, onSelect, onSaveFileNameChange, onSaveComplete, onSaveError, onDownAtEnd, onOpenSpecialFile }: Props = $props();

	// File filter state
	let showAllFiles = $state(false);
	let customFilter = $state<string | null>(null);
	let activeFilter = $derived(customFilter ? [customFilter] : showAllFiles ? ['*'] : fileFilter);
	// Calculate sub-area positions based on base position
	let pathBreadcrumbPosition = $derived({ x: position.x + CONTENT_OFFSETS.pathBreadcrumb.x, y: position.y + CONTENT_OFFSETS.pathBreadcrumb.y });
	let folderActionsPosition = $derived({ x: position.x + CONTENT_OFFSETS.top.x, y: position.y + CONTENT_OFFSETS.top.y });
	let listPosition = $derived({ x: position.x + CONTENT_OFFSETS.main.x, y: position.y + CONTENT_OFFSETS.main.y });
	let actionsPosition = $derived({ x: position.x + CONTENT_OFFSETS.side.x, y: position.y + CONTENT_OFFSETS.side.y });
	let listAreaID = $derived(`${areaID}-list`);
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
	let showCreateFileDialogState = $state(false);
	let showDeleteFileConfirm = $state(false);
	let showRenameFileDialogState = $state(false);
	let showEditorState = $state(false);
	let showLargeFileWarning = $state(false);
	let dialogError = $state<string | null>(null);
	let fileToDelete = $state<StorageItemData | null>(null);
	let fileToRename = $state<StorageItemData | null>(null);
	let fileToEdit = $state<StorageItemData | null>(null);
	let pendingEditFile = $state<StorageItemData | null>(null);
	let showOverwriteConfirmState = $state(false);
	let pendingSavePath = $state('');
	let saveErrorMessage = $state('');
	const LARGE_FILE_THRESHOLD = 1024 * 1024; // 1 MB
	let unregisterFolderActions: (() => void) | null = null;
	let unregisterList: (() => void) | null = null;
	let unregisterActions: (() => void) | null = null;
	let unregisterFilter: (() => void) | null = null;
	let unregisterSaveFileName: (() => void) | null = null;
	// Save file name mode
	let internalSaveFileName = $state(saveFileName ?? '');
	let saveFileNameInput: ReturnType<typeof Input> | undefined = $state();
	let saveFileNameActive = $derived($activeArea === `${areaID}-save-filename`);
	let saveFileNameColumn = $state(0); // 0 = input, 1 = button
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
	let folderActions = $derived(buildFolderActions($t, filesOnly, showAllFiles, fileFilter, selectFolderButton, customFilter ?? undefined));
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
			error = withDetail($t('fileBrowser.loadDirectoryFailed'), e.message);
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
			// At top of list - go to save filename input if in save mode, or folder actions
			if (error) {
				if (showPath) activateArea(`${areaID}-path`);
				else return false;
			} else if (saveFileName !== undefined) activateArea(`${areaID}-save-filename`);
			else activateArea(`${areaID}-folder-actions`);
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
			// Go to save filename input if in save mode, otherwise to file list
			if (saveFileName !== undefined) activateArea(`${areaID}-save-filename`);
			else activateArea(listAreaID);
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

	// File actions from fileBrowser.ts
	let fileActions = $derived(getFileActions($t, selectFileButton));

	const actionsAreaHandlers = {
		up: () => {
			if (selectedActionIndex > 0) {
				selectedActionIndex--;
				return true;
			}
			return true; // Block navigation outside actions panel
		},
		down: () => {
			if (selectedActionIndex < fileActions.length - 1) {
				selectedActionIndex++;
				return true;
			}
			return true; // Block navigation outside actions panel
		},
		left: () => true, // Block navigation outside actions panel
		right: () => true, // Block navigation outside actions panel
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
			return true; // Block navigation outside filter panel
		},
		down: () => {
			if (selectedFilterIndex < filterActions.length - 1) {
				selectedFilterIndex++;
				return true;
			}
			return true; // Block navigation outside filter panel
		},
		left: () => true, // Block navigation outside filter panel
		right: () => true, // Block navigation outside filter panel
		confirmDown: () => {},
		confirmUp: () => {
			const action = filterActions[selectedFilterIndex];
			if (action) handleFilterAction(action.id);
		},
		confirmCancel: () => {},
		back: () => closeFilterPanel(),
	};

	const saveFileNameAreaHandlers = {
		up: () => {
			// Go back to folder actions
			saveFileNameInput?.blur();
			activateArea(`${areaID}-folder-actions`);
			return true;
		},
		down: () => {
			// Go to file list
			saveFileNameInput?.blur();
			activateArea(listAreaID);
			return true;
		},
		left: () => {
			if (saveFileNameColumn > 0) {
				saveFileNameColumn--;
				return true;
			}
			return true; // Stay in input, let it handle cursor
		},
		right: () => {
			if (saveFileNameColumn < 1) {
				saveFileNameColumn++;
				saveFileNameInput?.blur();
				return true;
			}
			return true;
		},
		confirmDown: () => {},
		confirmUp: () => {
			if (saveFileNameColumn === 0) {
				// Input is selected - focus it for editing
				saveFileNameInput?.focus();
			} else {
				// Button is selected - confirm save
				handleSave();
			}
		},
		confirmCancel: () => {},
		back: () => {
			saveFileNameInput?.blur();
			onBack?.();
		},
	};

	function handleSaveFileNameChange(value: string) {
		internalSaveFileName = value;
		onSaveFileNameChange?.(value);
	}

	function handleAction(actionId: string) {
		const item = items[selectedIndex];
		if (!item || item.type !== 'file') return;
		switch (actionId) {
			case 'select':
				onSelect?.(item.path);
				break;
			case 'open':
				handleOpenFile(item);
				break;
			case 'edit':
				showEditor(item);
				return;
			case 'rename':
				showRenameFileDialog(item);
				return; // Don't close actions panel yet
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
			case 'createFile':
				showCreateFileDialog();
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
		pushBreadcrumb($t('fileBrowser.customFilter'));
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
		pushBreadcrumb($t('common.delete'));
	}

	async function confirmDeleteFolder() {
		const result = await deleteFileOrFolder(currentPath);
		if (result.success) {
			if (parentPath !== null) await loadDirectory(parentPath); // Navigate to parent after deletion
		} else error = withDetail($t('fileBrowser.deleteFolderFailed'), result.error);
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
		dialogError = null;
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
		pushBreadcrumb($t('fileBrowser.newFolder'));
	}

	async function confirmNewFolder(folderName: string) {
		if (!folderName) {
			dialogError = $t('fileBrowser.folderNameRequired');
			return;
		}
		const newPath = joinPathWithSeparator(currentPath, folderName, separator);
		const result = await createFolder(newPath);
		if (result.success) {
			// Reload directory and select the new folder
			await loadDirectory(currentPath, folderName);
			cancelNewFolder(true); // Pass true to indicate success - focus on list
		} else {
			dialogError = withDetail($t('fileBrowser.createFolderFailed'), result.error);
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

	function showCreateFileDialog() {
		showCreateFileDialogState = true;
		dialogError = null;
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
		pushBreadcrumb($t('fileBrowser.createFile'));
	}

	async function confirmCreateFile(fileName: string) {
		if (!fileName) {
			dialogError = $t('fileBrowser.fileNameRequired');
			return;
		}
		const filePath = joinPathWithSeparator(currentPath, fileName, separator);
		const result = await api.fs.writeText(filePath, '');
		if (result.success) {
			// Reload directory and select the new file
			await loadDirectory(currentPath, fileName);
			cancelCreateFile(true);
		} else dialogError = withDetail($t('fileBrowser.createFileFailed'), result.error);
	}

	async function cancelCreateFile(focusList = false) {
		showCreateFileDialogState = false;
		popBreadcrumb();
		await tick();
		// Re-register all areas
		unregisterFolderActions = useArea(`${areaID}-folder-actions`, folderActionsAreaHandlers, folderActionsPosition);
		unregisterList = useArea(`${areaID}-list`, areaHandlers, listPosition);
		unregisterActions = useArea(`${areaID}-actions`, actionsAreaHandlers, actionsPosition);
		if (focusList) activateArea(listAreaID);
		else activateArea(`${areaID}-folder-actions`);
	}

	async function handleOpenFile(item: StorageItemData) {
		// Check for special file types (.lish, .lishs, .lishnet, .lishnets)
		const lowerName = item.name.toLowerCase();
		if (onOpenSpecialFile) {
			if (lowerName.endsWith('.lish') || lowerName.endsWith('.lishs')) {
				onOpenSpecialFile(item.path, 'lish');
				showActions = false;
				activateArea(listAreaID);
				return;
			}
			if (lowerName.endsWith('.lishnet') || lowerName.endsWith('.lishnets')) {
				onOpenSpecialFile(item.path, 'lishnet');
				showActions = false;
				activateArea(listAreaID);
				return;
			}
		}
		// Standard file open
		const result = await openFile(item.path);
		if (!result.success) error = withDetail($t('fileBrowser.openFileFailed'), result.error);
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
		pushBreadcrumb($t('fileBrowser.deleteFile'));
	}

	async function confirmDeleteFile() {
		if (!fileToDelete) return;
		const result = await deleteFileOrFolder(fileToDelete.path);
		if (result.success) {
			// Reload directory
			await loadDirectory(currentPath);
		} else {
			error = withDetail($t('fileBrowser.deleteFileFailed'), result.error);
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

	function showRenameFileDialog(item: StorageItemData) {
		fileToRename = item;
		showRenameFileDialogState = true;
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
		pushBreadcrumb($t('fileBrowser.renameFile'));
	}

	async function confirmRenameFile(newName: string) {
		if (!fileToRename) return;
		const result = await renameFile(fileToRename.path, newName);
		if (result.success) {
			// Reload directory and select the renamed file
			await loadDirectory(currentPath, newName);
		} else error = withDetail($t('fileBrowser.renameFileFailed'), result.error);
		cancelRenameFile();
	}

	async function cancelRenameFile() {
		showRenameFileDialogState = false;
		fileToRename = null;
		popBreadcrumb();
		await tick();
		// Re-register all areas
		unregisterFolderActions = useArea(`${areaID}-folder-actions`, folderActionsAreaHandlers, folderActionsPosition);
		unregisterList = useArea(`${areaID}-list`, areaHandlers, listPosition);
		unregisterActions = useArea(`${areaID}-actions`, actionsAreaHandlers, actionsPosition);
		activateArea(listAreaID);
	}

	function showEditor(item: StorageItemData) {
		// Check if file is larger than 1MB
		if (item.size && item.size > LARGE_FILE_THRESHOLD) {
			showLargeFileWarning = true;
			pendingEditFile = item;
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
			pushBreadcrumb($t('fileBrowser.largeFileWarning'));
			return;
		}
		openEditor(item);
	}

	function openEditor(item: StorageItemData) {
		fileToEdit = item;
		showEditorState = true;
		showActions = false;
		// Unregister areas so editor can take over
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
	}

	function confirmLargeFileEdit() {
		if (pendingEditFile) {
			showLargeFileWarning = false;
			popBreadcrumb();
			openEditor(pendingEditFile);
			pendingEditFile = null;
		}
	}

	async function cancelLargeFileEdit() {
		showLargeFileWarning = false;
		pendingEditFile = null;
		popBreadcrumb();
		await tick();
		// Re-register all areas
		unregisterFolderActions = useArea(`${areaID}-folder-actions`, folderActionsAreaHandlers, folderActionsPosition);
		unregisterList = useArea(`${areaID}-list`, areaHandlers, listPosition);
		unregisterActions = useArea(`${areaID}-actions`, actionsAreaHandlers, actionsPosition);
		activateArea(listAreaID);
	}

	async function closeEditor() {
		showEditorState = false;
		fileToEdit = null;
		await tick();
		// Re-register all areas
		unregisterFolderActions = useArea(`${areaID}-folder-actions`, folderActionsAreaHandlers, folderActionsPosition);
		unregisterList = useArea(`${areaID}-list`, areaHandlers, listPosition);
		unregisterActions = useArea(`${areaID}-actions`, actionsAreaHandlers, actionsPosition);
		activateArea(listAreaID);
	}

	// Save file with content - handles exists check and overwrite dialog
	async function handleSave() {
		if (saveContent === undefined) {
			// No content to save, just call onSelect
			onSelect?.(currentPath);
			return;
		}
		saveErrorMessage = '';
		const fullPath = joinPathWithSeparator(currentPath, internalSaveFileName, separator);
		try {
			const { exists } = await api.fs.exists(fullPath);
			if (exists) {
				// File exists, show confirmation dialog
				pendingSavePath = fullPath;
				showOverwriteConfirmState = true;
				return;
			}
			// File doesn't exist, write directly
			if (useGzip) await api.fs.writeGzip(fullPath, saveContent);
			else await api.fs.writeText(fullPath, saveContent);
			onSaveComplete?.(fullPath);
		} catch (e) {
			console.error('Failed to save file:', e);
			saveErrorMessage = e instanceof Error ? e.message : String(e);
			onSaveError?.(saveErrorMessage);
		}
	}

	async function confirmOverwrite() {
		showOverwriteConfirmState = false;
		saveErrorMessage = '';
		if (saveContent === undefined) return;
		try {
			if (useGzip) await api.fs.writeGzip(pendingSavePath, saveContent);
			else await api.fs.writeText(pendingSavePath, saveContent);
			onSaveComplete?.(pendingSavePath);
		} catch (e) {
			console.error('Failed to save file:', e);
			saveErrorMessage = e instanceof Error ? e.message : String(e);
			onSaveError?.(saveErrorMessage);
		}
	}

	async function cancelOverwrite() {
		showOverwriteConfirmState = false;
		await tick();
		// Reactivate the save filename area after dialog closes
		if (saveFileName !== undefined) {
			activateArea(`${areaID}-save-filename`);
		} else {
			activateArea(listAreaID);
		}
	}

	async function handleBreadcrumbNavigate(path: string) {
		// If editor is open, close it first
		if (showEditorState) {
			showEditorState = false;
			fileToEdit = null;
			await tick();
			// Re-register all areas
			unregisterFolderActions = useArea(`${areaID}-folder-actions`, folderActionsAreaHandlers, folderActionsPosition);
			unregisterList = useArea(`${areaID}-list`, areaHandlers, listPosition);
			unregisterActions = useArea(`${areaID}-actions`, actionsAreaHandlers, actionsPosition);
		}
		loadDirectory(path);
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
		if (saveFileName !== undefined) unregisterSaveFileName = useArea(`${areaID}-save-filename`, saveFileNameAreaHandlers, folderActionsPosition);
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
				await loadDirectory(startPath || info.home || '', initialFile);
			} catch (e: any) {
				error = withDetail($t('fileBrowser.initializeFailed'), e.message);
				loading = false;
			}
		})();
		return () => {
			if (unregisterFolderActions) unregisterFolderActions();
			if (unregisterSaveFileName) unregisterSaveFileName();
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
		height: 100%;
		overflow: hidden;
	}

	.content {
		display: flex;
		flex-direction: column;
		gap: 2vh;
		margin: 2vh;
		flex: 1;
		min-height: 0;
	}

	.table-row {
		display: flex;
		flex-direction: row;
		gap: 2vh;
		flex: 1;
		min-height: 0;
	}

	.container {
		flex: 1;
		display: flex;
		flex-direction: column;
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
		gap: 1vh;
		min-width: 20vh;
	}

	.folder-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 1vh;
	}

	.save-filename-row {
		display: flex;
		flex-direction: row;
		gap: 1vh;
		align-items: flex-end;
	}

	.save-filename-row :global(.input-container) {
		flex: 1;
	}
</style>

<div class="browser">
	{#if showPath}
		<PathBreadcrumb bind:this={pathBreadcrumb} areaID="{areaID}-path" position={pathBreadcrumbPosition} path={showEditorState && fileToEdit ? fileToEdit.path : currentPath} {separator} onNavigate={handleBreadcrumbNavigate} onDown={() => (showEditorState ? `${areaID}-editor-toolbar` : error ? `${areaID}-list` : `${areaID}-folder-actions`)} />
	{/if}
	{#if showEditorState && fileToEdit}
		<Editor areaID="{areaID}-editor" filePath={fileToEdit.path} fileName={fileToEdit.name} {position} onBack={closeEditor} onUp={() => activateArea(`${areaID}-path`)} />
	{:else}
		<div class="content">
			{#if error}
				<Alert type="error" message={error} />
			{:else}
				<div class="folder-actions">
					{#each folderActions as action, index (action.id)}
						<Button label={action.label} icon={action.icon} selected={folderActionsActive && selectedFolderActionIndex === index} onConfirm={() => handleFolderAction(action.id)} />
					{/each}
				</div>
			{/if}
			{#if saveFileName !== undefined}
				<div class="save-filename-row">
					<Input bind:this={saveFileNameInput} label={$t('common.fileName')} value={internalSaveFileName} selected={saveFileNameActive && saveFileNameColumn === 0} onchange={handleSaveFileNameChange} />
					<Button label={$t('common.save')} icon="/img/check.svg" selected={saveFileNameActive && saveFileNameColumn === 1} onConfirm={handleSave} />
				</div>
				{#if saveErrorMessage}
					<Alert type="error" message={saveErrorMessage} />
				{/if}
			{/if}
			<div class="table-row">
				<div class="container">
					<Table {columns} noBorder>
						<Header>
							<Cell>{$t('localStorage.name')}</Cell>
							<Cell align="right" desktopOnly>{$t('localStorage.size')}</Cell>
							<Cell align="right" desktopOnly>{$t('localStorage.modified')}</Cell>
						</Header>
						<div class="items">
							{#if loading}
								<div class="loading">
									<Spinner size="8vh" />
								</div>
							{:else if error}
								{#each items as item, index (item.id)}
									<div bind:this={itemElements[index]}>
										<StorageItem name={item.name} type={item.type} size={item.size} modified={item.modified} selected={(active || actionsActive) && selectedIndex === index} isLast={index === items.length - 1} odd={index % 2 === 0} />
									</div>
								{/each}
							{:else}
								{#each items as item, index (item.id)}
									<div bind:this={itemElements[index]}>
										<StorageItem name={item.name} type={item.type} size={item.size} modified={item.modified} selected={(active || actionsActive) && selectedIndex === index} isLast={index === items.length - 1} odd={index % 2 === 0} />
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
	{/if}
</div>
{#if showDeleteConfirm}
	<ConfirmDialog title={$t('fileBrowser.deleteFolder')} message={$t('fileBrowser.confirmDeleteFolder').replace('{path}', currentPath)} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmDeleteFolder} onBack={cancelDeleteFolder} />
{/if}
{#if showDeleteFileConfirm && fileToDelete}
	<ConfirmDialog title={$t('fileBrowser.deleteFile')} message={$t('fileBrowser.confirmDeleteFile').replace('{name}', fileToDelete.name)} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmDeleteFile} onBack={cancelDeleteFile} />
{/if}
{#if showNewFolderDialogState}
	<InputDialog title={$t('fileBrowser.newFolder')} label={$t('fileBrowser.folderName')} placeholder={$t('fileBrowser.enterFolderName')} confirmLabel={$t('common.create')} cancelLabel={$t('common.cancel')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" error={dialogError} {position} onConfirm={confirmNewFolder} onBack={cancelNewFolder} />
{/if}
{#if showCreateFileDialogState}
	<InputDialog title={$t('fileBrowser.createFile')} label={$t('common.fileName')} placeholder={$t('fileBrowser.enterFileName')} confirmLabel={$t('common.create')} cancelLabel={$t('common.cancel')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" error={dialogError} {position} onConfirm={confirmCreateFile} onBack={cancelCreateFile} />
{/if}
{#if showRenameFileDialogState && fileToRename}
	<InputDialog title={$t('fileBrowser.renameFile')} label={$t('common.fileName')} placeholder={$t('fileBrowser.enterFileName')} initialValue={fileToRename.name} confirmLabel={$t('common.ok')} cancelLabel={$t('common.cancel')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmRenameFile} onBack={cancelRenameFile} />
{/if}
{#if showLargeFileWarning && pendingEditFile}
	<ConfirmDialog title={$t('fileBrowser.largeFileWarning')} message={$t('fileBrowser.largeFileWarningMessage').replace('{name}', pendingEditFile.name).replace('{size}', formatSize(pendingEditFile.size))} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmLargeFileEdit} onBack={cancelLargeFileEdit} />
{/if}
{#if showCustomFilterDialog}
	<InputDialog title={$t('fileBrowser.customFilter')} label={$t('fileBrowser.filterPattern')} placeholder={$t('fileBrowser.enterFilterPattern')} initialValue={customFilter ?? ''} confirmLabel={$t('common.ok')} cancelLabel={$t('common.cancel')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmCustomFilter} onBack={closeCustomFilterDialog} />
{/if}
{#if showOverwriteConfirmState}
	<ConfirmDialog title={$t('common.overwriteFile')} message={$t('common.fileExistsOverwrite').replace('{name}', internalSaveFileName)} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmOverwrite} onBack={cancelOverwrite} />
{/if}
