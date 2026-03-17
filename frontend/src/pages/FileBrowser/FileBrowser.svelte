<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { useArea, activateArea, activeArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_OFFSETS } from '../../scripts/navigationLayout.ts';
	import { t, withDetail, translateError } from '../../scripts/language.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { api } from '../../scripts/api.ts';
	import { getParentPath, loadDirectoryFromAPI, createParentEntry, isAtRoot, getCurrentDirName, buildDirectoryActions, buildFilterActions, deleteFileOrDirectory, createDirectory, openFile, renameFile, getFileSystemInfo, joinPathWithSeparator, getFileActions, type LoadDirectoryOptions } from '../../scripts/fileBrowser.ts';
	import { scrollToElement, formatSize } from '../../scripts/utils.ts';
	import { type StorageItemData } from '../../scripts/storage.ts';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import Table from '../../components/Table/Table.svelte';
	import Header from '../../components/Table/TableHeader.svelte';
	import Cell from '../../components/Table/TableCell.svelte';
	import StorageItem from '../Storage/StorageItem.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	import PathBreadcrumb from './FileBrowserBreadcrumb.svelte';
	import ConfirmDialog from '../../components/Dialog/ConfirmDialog.svelte';
	import InputDialog from '../../components/Dialog/InputDialog.svelte';
	import Editor from '../Editor/Editor.svelte';
	interface Props {
		areaID: string;
		position: Position;
		initialPath?: string | undefined;
		initialFile?: string | undefined; // File name to select in the initial directory
		directoriesOnly?: boolean | undefined;
		filesOnly?: boolean | undefined;
		fileFilter?: string[] | undefined; // Array of extensions like ['.lish', '.json'] or ['*'] for all
		fileFilterName?: string | undefined; // Display name for the filter (e.g. 'LISH files')
		showPath?: boolean | undefined;
		selectDirectoryButton?: boolean | undefined;
		selectFileButton?: boolean | undefined;
		saveFileName?: string | undefined; // If provided, shows a filename input for "save as" mode
		saveContent?: string | undefined; // Content to save - if provided, FileBrowser handles the save operation
		useGzip?: boolean | undefined; // If true, compress content with gzip before saving
		onBack?: (() => void) | undefined;
		onSelect?: ((path: string) => void) | undefined;
		onSaveFileNameChange?: ((fileName: string) => void) | undefined;
		onSaveComplete?: ((path: string) => void) | undefined; // Called after successful save
		onSaveError?: ((error: string) => void) | undefined; // Called on save error
		onDownAtEnd?: (() => boolean) | undefined;
		specialFileTypes?: { extensions: string[]; onOpen: (path: string) => void }[] | undefined;
	}
	const columns = '1fr 8vw 12vw';
	let { areaID, position, initialPath = '', initialFile, directoriesOnly = false, filesOnly = false, fileFilter, fileFilterName, showPath = true, selectDirectoryButton: selectDirectoryButton = false, selectFileButton = false, saveFileName, saveContent, useGzip = false, onBack, onSelect, onSaveFileNameChange, onSaveComplete, onSaveError, onDownAtEnd, specialFileTypes }: Props = $props();

	// File filter state
	let showAllFiles = $state(false);
	let customFilter = $state<string | null>(null);
	let activeFilter = $derived(customFilter ? [customFilter] : showAllFiles ? ['*'] : fileFilter);
	// Calculate sub-area positions based on base position
	let pathBreadcrumbPosition = $derived({ x: position.x + CONTENT_OFFSETS.pathBreadcrumb.x, y: position.y + CONTENT_OFFSETS.pathBreadcrumb.y });
	let directoryActionsPosition = $derived({ x: position.x + CONTENT_OFFSETS.top.x, y: position.y + CONTENT_OFFSETS.top.y });
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
	let showDeleteConfirm = $state(false);
	let showNewDirectoryDialogState = $state(false);
	let showCreateFileDialogState = $state(false);
	let showDeleteFileConfirm = $state(false);
	let showRenameDialogState = $state(false);
	let showEditorState = $state(false);
	let showLargeFileWarning = $state(false);
	let dialogError = $state<string | undefined>(undefined);
	let fileToDelete = $state<StorageItemData | null>(null);
	let itemToRename = $state<StorageItemData | null>(null);
	let fileToEdit = $state<StorageItemData | null>(null);
	let pendingEditFile = $state<StorageItemData | null>(null);
	let showOverwriteConfirmState = $state(false);
	let pendingSavePath = $state('');
	let saveErrorMessage = $state('');
	const LARGE_FILE_THRESHOLD = 1024 * 1024; // 1 MB
	let unregisterDirectoryActions: (() => void) | null = null;
	let unregisterList: (() => void) | null = null;
	let unregisterActions: (() => void) | null = null;
	let unregisterFilter: (() => void) | null = null;
	let unregisterSaveFileName: (() => void) | null = null;
	// Save file name mode
	function getInitialSaveFileName(): string {
		return saveFileName ?? '';
	}
	let internalSaveFileName = $state(getInitialSaveFileName());
	let saveFileNameInput: ReturnType<typeof Input> | undefined = $state();
	let saveFileNameActive = $derived($activeArea === `${areaID}-save-filename`);
	let saveFileNameColumn = $state(0); // 0 = input, 1 = button
	let selectedItem = $derived(items[selectedIndex]);
	// Directory toolbar actions
	let directoryActions = $derived(buildDirectoryActions($t, filesOnly, showAllFiles, fileFilter, fileFilterName, selectDirectoryButton, customFilter ?? undefined, currentPath));
	let selectedDirectoryActionIndex = $state(0);
	let directoryActionsActive = $derived($activeArea === `${areaID}-directory-actions`);
	// Filter panel actions
	let filterActions = $derived(buildFilterActions($t, fileFilter, fileFilterName, customFilter ?? undefined));
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
			const options: LoadDirectoryOptions = { directoriesOnly: directoriesOnly, filesOnly, fileFilter: activeFilter };
			const result = await loadDirectoryFromAPI(path, separator, options);
			currentPath = result.path;
			parentPath = result.parentPath;
			items = result.items;
			// Select specific item by name, or default to first
			if (selectName) {
				const idx = result.items.findIndex(e => e.name === selectName);
				selectedIndex = idx >= 0 ? idx : 0;
			} else selectedIndex = 0;
		} catch (e: any) {
			error = withDetail($t('fileBrowser.loadDirectoryFailed'), translateError(e));
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

	function scrollToSelected(): void {
		scrollToElement(itemElements, selectedIndex);
	}

	async function navigateInto(item: StorageItemData): Promise<void> {
		if (item.type === 'directory' || item.type === 'drive') {
			// If navigating to "..", select the directory we came from
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
		up() {
			if (selectedIndex > 0) {
				selectedIndex--;
				showActions = false; // Hide actions when selection changes
				scrollToSelected();
				return true;
			}
			// At top of list - go to save filename input if in save mode, or directory actions
			if (error) {
				if (showPath) activateArea(`${areaID}-path`);
				else return false;
			} else if (saveFileName !== undefined) activateArea(`${areaID}-save-filename`);
			else activateArea(`${areaID}-directory-actions`);
			return true;
		},
		down() {
			if (selectedIndex < items.length - 1) {
				selectedIndex++;
				showActions = false; // Hide actions when selection changes
				scrollToSelected();
				return true;
			}
			if (onDownAtEnd) return onDownAtEnd();
			return false; // Allow navigation to other areas
		},
		left() {
			return false;
		}, // Allow navigation to other areas
		right() {
			return !showActions;
		}, // Allow navigation to actions panel only when it's visible
		confirmDown() {},
		confirmUp() {
			const item = items[selectedIndex];
			if (item && (item.type === 'directory' || item.type === 'drive'))
				navigateInto(item); // Directories/drives - navigate into them
			else if (item?.type === 'file') {
				if (saveFileName !== undefined) {
					// In save mode, selecting a file sets the filename and triggers save (with overwrite check)
					internalSaveFileName = item.name;
					onSaveFileNameChange?.(item.name);
					handleSave();
				} else if (filesOnly) onSelect?.(item.path);
				else openActions(); // Otherwise show actions panel
			}
		},
		confirmCancel() {},
		back() {
			if (parentPath !== null) navigateUp();
			else onBack?.();
		},
	};

	const directoryActionsAreaHandlers = {
		up() {
			// Go to path breadcrumb if available
			if (showPath) {
				activateArea(`${areaID}-path`);
				return true;
			}
			// Otherwise let areaNavigate handle it (go to global breadcrumb)
			return false;
		},
		down() {
			// Go to save filename input if in save mode, otherwise to file list
			if (saveFileName !== undefined) activateArea(`${areaID}-save-filename`);
			else activateArea(listAreaID);
			return true;
		},
		left() {
			if (selectedDirectoryActionIndex > 0) {
				selectedDirectoryActionIndex--;
				return true;
			}
			return false;
		},
		right() {
			if (selectedDirectoryActionIndex < directoryActions.length - 1) {
				selectedDirectoryActionIndex++;
				return true;
			}
			return false;
		},
		confirmDown() {},
		confirmUp() {
			const action = directoryActions[selectedDirectoryActionIndex];
			if (action) handleDirectoryAction(action.id);
		},
		confirmCancel() {},
		back() {
			if (parentPath !== null) navigateUp();
			else onBack?.();
		},
	};

	// File actions from fileBrowser.ts
	let fileActions = $derived(getFileActions($t, selectFileButton));

	const actionsAreaHandlers = {
		up() {
			if (selectedActionIndex > 0) {
				selectedActionIndex--;
				return true;
			}
			return true; // Block navigation outside actions panel
		},
		down() {
			if (selectedActionIndex < fileActions.length - 1) {
				selectedActionIndex++;
				return true;
			}
			return true; // Block navigation outside actions panel
		},
		left() {
			return true;
		}, // Block navigation outside actions panel
		right() {
			return true;
		}, // Block navigation outside actions panel
		confirmDown() {},
		confirmUp() {
			const action = fileActions[selectedActionIndex];
			if (action) handleAction(action.id);
		},
		confirmCancel() {},
		back() {
			showActions = false;
			activateArea(listAreaID);
		},
	};

	const filterAreaHandlers = {
		up() {
			if (selectedFilterIndex > 0) {
				selectedFilterIndex--;
				return true;
			}
			return true; // Block navigation outside filter panel
		},
		down() {
			if (selectedFilterIndex < filterActions.length - 1) {
				selectedFilterIndex++;
				return true;
			}
			return true; // Block navigation outside filter panel
		},
		left() {
			return true;
		}, // Block navigation outside filter panel
		right() {
			return true;
		}, // Block navigation outside filter panel
		confirmDown() {},
		confirmUp() {
			const action = filterActions[selectedFilterIndex];
			if (action) handleFilterAction(action.id);
		},
		confirmCancel() {},
		back() {
			closeFilterPanel();
		},
	};

	const saveFileNameAreaHandlers = {
		up() {
			// Go back to directory actions
			saveFileNameInput?.blur();
			activateArea(`${areaID}-directory-actions`);
			return true;
		},
		down() {
			// Go to file list
			saveFileNameInput?.blur();
			activateArea(listAreaID);
			return true;
		},
		left() {
			if (saveFileNameColumn > 0) {
				saveFileNameColumn--;
				return true;
			}
			return true; // Stay in input, let it handle cursor
		},
		right() {
			if (saveFileNameColumn < 1) {
				saveFileNameColumn++;
				saveFileNameInput?.blur();
				return true;
			}
			return true;
		},
		confirmDown() {},
		confirmUp() {
			if (saveFileNameColumn === 0) {
				// Input is selected - focus it for editing
				saveFileNameInput?.focus();
			} else {
				// Button is selected - confirm save
				handleSave();
			}
		},
		confirmCancel() {},
		back() {
			saveFileNameInput?.blur();
			onBack?.();
		},
	};

	function handleSaveFileNameChange(value: string): void {
		internalSaveFileName = value;
		onSaveFileNameChange?.(value);
	}

	function handleAction(actionID: string): void {
		const item = items[selectedIndex];
		if (!item || item.type !== 'file') return;
		switch (actionID) {
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
				showRenameDialog(item);
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

	function handleDirectoryAction(actionID: string): void {
		switch (actionID) {
			case 'select':
				onSelect?.(currentPath);
				break;
			case 'new':
				showNewDirectoryDialog();
				break;
			case 'rename':
				showRenameDirectoryDialog();
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

	function openFilterPanel(): void {
		showFilterPanel = true;
		selectedFilterIndex = 0;
		// Find current filter in the list to pre-select it
		if (showAllFiles) {
			const allIDx = filterActions.findIndex(a => a.id === '*');
			if (allIDx >= 0) selectedFilterIndex = allIDx;
		} else if (fileFilter && fileFilter.length > 0) selectedFilterIndex = 0; // Select first filter option
		unregisterFilter = useArea(`${areaID}-filter`, filterAreaHandlers, actionsPosition);
		activateArea(`${areaID}-filter`);
	}

	function closeFilterPanel(): void {
		showFilterPanel = false;
		if (unregisterFilter) {
			unregisterFilter();
			unregisterFilter = null;
		}
		activateArea(`${areaID}-directory-actions`);
	}

	function handleFilterAction(actionID: string): void {
		if (actionID === 'back') {
			closeFilterPanel();
			return;
		}
		if (actionID === 'custom') {
			openCustomFilterDialog();
			return;
		}
		// Set the filter
		if (actionID === '*') {
			showAllFiles = true;
			customFilter = null;
		} else if (actionID === 'filter') {
			showAllFiles = false;
			customFilter = null;
		}
		loadDirectory(currentPath);
		closeFilterPanel();
	}

	function openCustomFilterDialog(): void {
		showCustomFilterDialog = true;
		if (unregisterFilter) {
			unregisterFilter();
			unregisterFilter = null;
		}
		pushBreadcrumb($t('fileBrowser.customFilter'));
	}

	function closeCustomFilterDialog(): void {
		showCustomFilterDialog = false;
		popBreadcrumb();
		unregisterFilter = useArea(`${areaID}-filter`, filterAreaHandlers, actionsPosition);
		tick().then(() => activateArea(`${areaID}-filter`));
	}

	function confirmCustomFilter(value: string): void {
		customFilter = value.trim();
		showAllFiles = false;
		showCustomFilterDialog = false;
		popBreadcrumb();
		loadDirectory(currentPath);
		closeFilterPanel();
	}

	function showDeleteConfirmDialog(): void {
		showDeleteConfirm = true;
		// Unregister areas so dialog can take over
		if (unregisterDirectoryActions) {
			unregisterDirectoryActions();
			unregisterDirectoryActions = null;
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

	async function confirmDeleteDirectory(): Promise<void> {
		const dirName = getCurrentDirName(currentPath, separator);
		const result = await deleteFileOrDirectory(currentPath);
		if (result.success) {
			if (dirName) addNotification($t('fileBrowser.directoryDeleted', { name: dirName }));
			if (parentPath !== null) await loadDirectory(parentPath); // Navigate to parent after deletion
		} else error = withDetail($t('fileBrowser.deleteDirectoryFailed'), result.error);
		cancelDeleteDirectory();
	}

	async function cancelDeleteDirectory(): Promise<void> {
		showDeleteConfirm = false;
		popBreadcrumb();
		await tick();
		// Re-register all areas
		unregisterDirectoryActions = useArea(`${areaID}-directory-actions`, directoryActionsAreaHandlers, directoryActionsPosition);
		unregisterList = useArea(`${areaID}-list`, areaHandlers, listPosition);
		unregisterActions = useArea(`${areaID}-actions`, actionsAreaHandlers, actionsPosition);
		activateArea(`${areaID}-directory-actions`);
	}

	function showNewDirectoryDialog(): void {
		showNewDirectoryDialogState = true;
		dialogError = undefined;
		// Unregister areas so dialog can take over
		if (unregisterDirectoryActions) {
			unregisterDirectoryActions();
			unregisterDirectoryActions = null;
		}
		if (unregisterList) {
			unregisterList();
			unregisterList = null;
		}
		if (unregisterActions) {
			unregisterActions();
			unregisterActions = null;
		}
		pushBreadcrumb($t('fileBrowser.newDirectory'));
	}

	async function confirmNewDirectory(directoryName: string): Promise<void> {
		if (!directoryName) {
			dialogError = $t('fileBrowser.directoryNameRequired');
			return;
		}
		const newPath = joinPathWithSeparator(currentPath, directoryName, separator);
		const result = await createDirectory(newPath);
		if (result.success) {
			addNotification($t('fileBrowser.directoryCreated', { name: directoryName }));
			// Reload directory and select the new directory
			await loadDirectory(currentPath, directoryName);
			cancelNewDirectory(true); // Pass true to indicate success - focus on list
		} else dialogError = withDetail($t('fileBrowser.createDirectoryFailed'), result.error);
	}

	async function cancelNewDirectory(focusList = false): Promise<void> {
		showNewDirectoryDialogState = false;
		popBreadcrumb();
		await tick();
		// Re-register all areas
		unregisterDirectoryActions = useArea(`${areaID}-directory-actions`, directoryActionsAreaHandlers, directoryActionsPosition);
		unregisterList = useArea(`${areaID}-list`, areaHandlers, listPosition);
		unregisterActions = useArea(`${areaID}-actions`, actionsAreaHandlers, actionsPosition);
		// Focus on list if directory was created successfully, otherwise on toolbar
		if (focusList) activateArea(listAreaID);
		else activateArea(`${areaID}-directory-actions`);
	}

	function showCreateFileDialog(): void {
		showCreateFileDialogState = true;
		dialogError = undefined;
		// Unregister areas so dialog can take over
		if (unregisterDirectoryActions) {
			unregisterDirectoryActions();
			unregisterDirectoryActions = null;
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

	async function confirmCreateFile(fileName: string): Promise<void> {
		if (!fileName) {
			dialogError = $t('fileBrowser.fileNameRequired');
			return;
		}
		const filePath = joinPathWithSeparator(currentPath, fileName, separator);
		const result = await api.fs.writeText(filePath, '');
		if (result.success) {
			addNotification($t('fileBrowser.fileCreated', { name: fileName }));
			// Reload directory and select the new file
			await loadDirectory(currentPath, fileName);
			cancelCreateFile(true);
		} else dialogError = withDetail($t('fileBrowser.createFileFailed'), result.error);
	}

	async function cancelCreateFile(focusList = false): Promise<void> {
		showCreateFileDialogState = false;
		popBreadcrumb();
		await tick();
		// Re-register all areas
		unregisterDirectoryActions = useArea(`${areaID}-directory-actions`, directoryActionsAreaHandlers, directoryActionsPosition);
		unregisterList = useArea(`${areaID}-list`, areaHandlers, listPosition);
		unregisterActions = useArea(`${areaID}-actions`, actionsAreaHandlers, actionsPosition);
		if (focusList) activateArea(listAreaID);
		else activateArea(`${areaID}-directory-actions`);
	}

	async function handleOpenFile(item: StorageItemData): Promise<void> {
		// Check for special file types (.lish, .lishs, .lishnet, .lishnets) including .gz variants
		const lowerName = item.name.toLowerCase();
		if (specialFileTypes) {
			for (const { extensions, onOpen } of specialFileTypes) {
				if (extensions.some(ext => lowerName.endsWith(ext))) {
					onOpen(item.path);
					showActions = false;
					activateArea(listAreaID);
					return;
				}
			}
		}
		// Standard file open
		const result = await openFile(item.path);
		if (!result.success) error = withDetail($t('fileBrowser.openFileFailed'), result.error);
		showActions = false;
		activateArea(listAreaID);
	}

	function showDeleteFileConfirmDialog(item: StorageItemData): void {
		fileToDelete = item;
		showDeleteFileConfirm = true;
		showActions = false;
		// Unregister areas so dialog can take over
		if (unregisterDirectoryActions) {
			unregisterDirectoryActions();
			unregisterDirectoryActions = null;
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

	async function confirmDeleteFile(): Promise<void> {
		if (!fileToDelete) return;
		const result = await deleteFileOrDirectory(fileToDelete.path);
		if (result.success) {
			addNotification($t('fileBrowser.fileDeleted', { name: fileToDelete.name }));
			// Reload directory
			await loadDirectory(currentPath);
		} else error = withDetail($t('fileBrowser.deleteFileFailed'), result.error);
		cancelDeleteFile();
	}

	async function cancelDeleteFile(): Promise<void> {
		showDeleteFileConfirm = false;
		fileToDelete = null;
		popBreadcrumb();
		await tick();
		// Re-register all areas
		unregisterDirectoryActions = useArea(`${areaID}-directory-actions`, directoryActionsAreaHandlers, directoryActionsPosition);
		unregisterList = useArea(`${areaID}-list`, areaHandlers, listPosition);
		unregisterActions = useArea(`${areaID}-actions`, actionsAreaHandlers, actionsPosition);
		activateArea(listAreaID);
	}

	function showRenameDirectoryDialog(): void {
		const dirName = getCurrentDirName(currentPath, separator);
		if (!dirName) return;
		showRenameDialog({ id: 'current-dir', name: dirName, path: currentPath, type: 'directory' });
	}

	function showRenameDialog(item: StorageItemData): void {
		itemToRename = item;
		showRenameDialogState = true;
		showActions = false;
		// Unregister areas so dialog can take over
		if (unregisterDirectoryActions) {
			unregisterDirectoryActions();
			unregisterDirectoryActions = null;
		}
		if (unregisterList) {
			unregisterList();
			unregisterList = null;
		}
		if (unregisterActions) {
			unregisterActions();
			unregisterActions = null;
		}
		const breadcrumb = item.type === 'directory' ? $t('fileBrowser.renameDirectory') : $t('fileBrowser.renameFile');
		pushBreadcrumb(breadcrumb);
	}

	async function confirmRename(newName: string): Promise<void> {
		if (!itemToRename) return;
		const isCurrentDir = itemToRename.id === 'current-dir';
		const result = await renameFile(itemToRename.path, newName);
		if (result.success) {
			const key = itemToRename.type === 'directory' ? 'fileBrowser.directoryRenamed' : 'fileBrowser.fileRenamed';
			addNotification($t(key, { name: newName }));
			if (isCurrentDir) {
				// Current directory was renamed - stay inside the renamed directory
				const parentPath = getParentPath(currentPath, separator);
				const newPath = joinPathWithSeparator(parentPath ?? '', newName, separator);
				await loadDirectory(newPath);
			} else {
				await loadDirectory(currentPath, newName);
			}
		} else error = withDetail($t('fileBrowser.renameFileFailed'), result.error);
		cancelRename();
	}

	async function cancelRename(): Promise<void> {
		showRenameDialogState = false;
		itemToRename = null;
		popBreadcrumb();
		await tick();
		// Re-register all areas
		unregisterDirectoryActions = useArea(`${areaID}-directory-actions`, directoryActionsAreaHandlers, directoryActionsPosition);
		unregisterList = useArea(`${areaID}-list`, areaHandlers, listPosition);
		unregisterActions = useArea(`${areaID}-actions`, actionsAreaHandlers, actionsPosition);
		activateArea(listAreaID);
	}

	function showEditor(item: StorageItemData): void {
		// Check if file is larger than 1MB
		if (item.size && item.size > LARGE_FILE_THRESHOLD) {
			showLargeFileWarning = true;
			pendingEditFile = item;
			showActions = false;
			// Unregister areas so dialog can take over
			if (unregisterDirectoryActions) {
				unregisterDirectoryActions();
				unregisterDirectoryActions = null;
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

	function openEditor(item: StorageItemData): void {
		fileToEdit = item;
		showEditorState = true;
		showActions = false;
		// Unregister areas so editor can take over
		if (unregisterDirectoryActions) {
			unregisterDirectoryActions();
			unregisterDirectoryActions = null;
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

	function confirmLargeFileEdit(): void {
		if (pendingEditFile) {
			showLargeFileWarning = false;
			popBreadcrumb();
			openEditor(pendingEditFile);
			pendingEditFile = null;
		}
	}

	async function cancelLargeFileEdit(): Promise<void> {
		showLargeFileWarning = false;
		pendingEditFile = null;
		popBreadcrumb();
		await tick();
		// Re-register all areas
		unregisterDirectoryActions = useArea(`${areaID}-directory-actions`, directoryActionsAreaHandlers, directoryActionsPosition);
		unregisterList = useArea(`${areaID}-list`, areaHandlers, listPosition);
		unregisterActions = useArea(`${areaID}-actions`, actionsAreaHandlers, actionsPosition);
		activateArea(listAreaID);
	}

	async function closeEditor(): Promise<void> {
		showEditorState = false;
		fileToEdit = null;
		await tick();
		// Re-register all areas
		unregisterDirectoryActions = useArea(`${areaID}-directory-actions`, directoryActionsAreaHandlers, directoryActionsPosition);
		unregisterList = useArea(`${areaID}-list`, areaHandlers, listPosition);
		unregisterActions = useArea(`${areaID}-actions`, actionsAreaHandlers, actionsPosition);
		activateArea(listAreaID);
	}

	// Save file with content - handles exists check and overwrite dialog
	async function handleSave(): Promise<void> {
		if (saveContent === undefined) {
			// No content to save, just call onSelect
			onSelect?.(currentPath);
			return;
		}
		saveErrorMessage = '';
		const fullPath = joinPathWithSeparator(currentPath, internalSaveFileName, separator);
		try {
			const result = await api.fs.exists(fullPath);
			if (result.exists && result.type === 'directory') {
				saveErrorMessage = $t('common.errorFileNameIsDirectory', { name: internalSaveFileName });
				return;
			}
			if (result.exists) {
				// File exists, show confirmation dialog
				pendingSavePath = fullPath;
				showOverwriteConfirmState = true;
				return;
			}
			// File doesn't exist, write directly
			if (useGzip) await api.fs.writeCompressed(fullPath, saveContent, 'gzip');
			else await api.fs.writeText(fullPath, saveContent);
			onSaveComplete?.(fullPath);
		} catch (e) {
			console.error('Failed to save file:', e);
			saveErrorMessage = translateError(e);
			onSaveError?.(saveErrorMessage);
		}
	}

	async function confirmOverwrite(): Promise<void> {
		showOverwriteConfirmState = false;
		saveErrorMessage = '';
		if (saveContent === undefined) return;
		try {
			if (useGzip) await api.fs.writeCompressed(pendingSavePath, saveContent, 'gzip');
			else await api.fs.writeText(pendingSavePath, saveContent);
			onSaveComplete?.(pendingSavePath);
		} catch (e) {
			console.error('Failed to save file:', e);
			saveErrorMessage = translateError(e);
			onSaveError?.(saveErrorMessage);
		}
	}

	async function cancelOverwrite(): Promise<void> {
		showOverwriteConfirmState = false;
		await tick();
		// Reactivate the save filename area after dialog closes
		if (saveFileName !== undefined) activateArea(`${areaID}-save-filename`);
		else activateArea(listAreaID);
	}

	async function handleBreadcrumbNavigate(path: string): Promise<void> {
		// If editor is open, close it first
		if (showEditorState) {
			showEditorState = false;
			fileToEdit = null;
			await tick();
			// Re-register all areas
			unregisterDirectoryActions = useArea(`${areaID}-directory-actions`, directoryActionsAreaHandlers, directoryActionsPosition);
			unregisterList = useArea(`${areaID}-list`, areaHandlers, listPosition);
			unregisterActions = useArea(`${areaID}-actions`, actionsAreaHandlers, actionsPosition);
		}
		loadDirectory(path);
	}

	export function getCurrentPath(): string {
		return currentPath;
	}

	export function getItemElements(): HTMLElement[] {
		return itemElements;
	}

	onMount(() => {
		// Register sub-areas with positions relative to content area
		unregisterDirectoryActions = useArea(`${areaID}-directory-actions`, directoryActionsAreaHandlers, directoryActionsPosition);
		if (saveFileName !== undefined) unregisterSaveFileName = useArea(`${areaID}-save-filename`, saveFileNameAreaHandlers, directoryActionsPosition);
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
				error = withDetail($t('fileBrowser.initializeFailed'), translateError(e));
				loading = false;
			}
		})();
		return () => {
			if (unregisterDirectoryActions) unregisterDirectoryActions();
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

	.directory-actions {
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
		<PathBreadcrumb areaID="{areaID}-path" position={pathBreadcrumbPosition} path={showEditorState && fileToEdit ? fileToEdit.path : currentPath} {separator} onNavigate={handleBreadcrumbNavigate} onDown={() => (showEditorState ? `${areaID}-editor-toolbar` : error ? `${areaID}-list` : `${areaID}-directory-actions`)} />
	{/if}
	{#if showEditorState && fileToEdit}
		<Editor areaID="{areaID}-editor" filePath={fileToEdit.path} fileName={fileToEdit.name} {position} onBack={closeEditor} onUp={() => activateArea(`${areaID}-path`)} />
	{:else}
		<div class="content">
			{#if error}
				<Alert type="error" message={error} />
			{:else}
				<div class="directory-actions">
					{#each directoryActions as action, index (action.id)}
						<Button label={action.label} icon={action.icon} selected={directoryActionsActive && selectedDirectoryActionIndex === index} onConfirm={() => handleDirectoryAction(action.id)} />
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
							<Cell>{$t('common.name')}</Cell>
							<Cell align="right" desktopOnly>{$t('common.size')}</Cell>
							<Cell align="right" desktopOnly>{$t('localStorage.modified')}</Cell>
						</Header>
						<div class="items">
							{#if loading}
								<div class="loading">
									<Spinner size="8vh" />
								</div>
							{:else if error}
								{#each items as item, index (item.id)}
									<StorageItem bind:el={itemElements[index]} name={item.name} type={item.type} size={item.size} modified={item.modified} selected={(active || actionsActive) && selectedIndex === index} isLast={index === items.length - 1} odd={index % 2 === 0} />
								{/each}
							{:else}
								{#each items as item, index (item.id)}
									<StorageItem bind:el={itemElements[index]} name={item.name} type={item.type} size={item.size} modified={item.modified} selected={(active || actionsActive) && selectedIndex === index} isLast={index === items.length - 1} odd={index % 2 === 0} />
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
	<ConfirmDialog title={$t('fileBrowser.deleteDirectory')} message={$t('fileBrowser.confirmDeleteDirectory', { path: currentPath })} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmDeleteDirectory} onBack={cancelDeleteDirectory} />
{/if}
{#if showDeleteFileConfirm && fileToDelete}
	<ConfirmDialog title={$t('fileBrowser.deleteFile')} message={$t('fileBrowser.confirmDeleteFile', { name: fileToDelete.name })} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmDeleteFile} onBack={cancelDeleteFile} />
{/if}
{#if showNewDirectoryDialogState}
	<InputDialog title={$t('fileBrowser.newDirectory')} label={$t('fileBrowser.directoryName')} placeholder={$t('fileBrowser.enterDirectoryName')} confirmLabel={$t('common.create')} cancelLabel={$t('common.cancel')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" error={dialogError} {position} onConfirm={confirmNewDirectory} onBack={cancelNewDirectory} />
{/if}
{#if showCreateFileDialogState}
	<InputDialog title={$t('fileBrowser.createFile')} label={$t('common.fileName')} placeholder={$t('fileBrowser.enterFileName')} confirmLabel={$t('common.create')} cancelLabel={$t('common.cancel')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" error={dialogError} {position} onConfirm={confirmCreateFile} onBack={cancelCreateFile} />
{/if}
{#if showRenameDialogState && itemToRename}
	{@const isDir = itemToRename.type === 'directory'}
	<InputDialog title={isDir ? $t('fileBrowser.renameDirectory') : $t('fileBrowser.renameFile')} label={isDir ? $t('fileBrowser.directoryName') : $t('common.fileName')} placeholder={isDir ? $t('fileBrowser.enterDirectoryName') : $t('fileBrowser.enterFileName')} initialValue={itemToRename.name} confirmLabel={$t('common.ok')} cancelLabel={$t('common.cancel')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmRename} onBack={cancelRename} />
{/if}
{#if showLargeFileWarning && pendingEditFile}
	<ConfirmDialog title={$t('fileBrowser.largeFileWarning')} message={$t('fileBrowser.largeFileWarningMessage', { name: pendingEditFile.name, size: formatSize(pendingEditFile.size) })} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmLargeFileEdit} onBack={cancelLargeFileEdit} />
{/if}
{#if showCustomFilterDialog}
	<InputDialog title={$t('fileBrowser.customFilter')} label={$t('fileBrowser.filterPattern')} placeholder={$t('fileBrowser.enterFilterPattern')} initialValue={customFilter ?? ''} confirmLabel={$t('common.ok')} cancelLabel={$t('common.cancel')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmCustomFilter} onBack={closeCustomFilterDialog} />
{/if}
{#if showOverwriteConfirmState}
	<ConfirmDialog title={$t('common.overwriteFile')} message={$t('common.errorFileExistsOverwrite', { name: internalSaveFileName })} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmOverwrite} onBack={cancelOverwrite} />
{/if}
