<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { activateArea, activeArea } from '../../scripts/areas.ts';
	import { isMouseActive } from '../../scripts/input/mouse.ts';
	import { type NavAction, type NavAreaOptions, type NavItem, type NavPos } from '../../scripts/navArea.svelte.ts';
	import NavScope from '../../components/NavArea/NavScope.svelte';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_OFFSETS } from '../../scripts/navigationLayout.ts';
	import { t, withDetail, translateError } from '../../scripts/language.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { api } from '../../scripts/api.ts';
	import { getParentPath, loadDirectoryFromAPI, createParentEntry, isAtRoot, getCurrentDirName, buildDirectoryActions, buildFilterActions, deleteFileOrDirectory, createDirectory, openFile, renameFile, getFileSystemInfo, joinPathWithSeparator, getFileActions, type LoadDirectoryOptions } from '../../scripts/fileBrowser.ts';
	import { formatSize } from '../../scripts/utils.ts';
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
		/** `browseDir` and `name` are the folder shown and the entry opened, so no caller has to split the path itself. */
		specialFileTypes?: { extensions: string[]; onOpen: (path: string, browseDir: string, name: string) => void }[] | undefined;
		/** When provided, adds a "Share" action for files and directories that calls back with the selected path and the directory currently being browsed (so callers can return the user to it). */
		onShare?: ((path: string, browseDir: string) => void) | undefined;
	}
	const columns = '1fr 8vw 12vw';
	let { areaID, position, initialPath = '', initialFile, directoriesOnly = false, filesOnly = false, fileFilter, fileFilterName, showPath = true, selectDirectoryButton: selectDirectoryButton = false, selectFileButton = false, saveFileName, saveContent, useGzip = false, onBack, onSelect, onSaveFileNameChange, onSaveComplete, onSaveError, onDownAtEnd, specialFileTypes, onShare }: Props = $props();

	// File filter state
	let showAllFiles = $state(false);
	let customFilter = $state<string | null>(null);
	let activeFilter = $derived(customFilter ? [customFilter] : showAllFiles ? ['*'] : fileFilter);
	// Calculate sub-area positions based on base position
	let pathBreadcrumbPosition = $derived({ x: position.x + CONTENT_OFFSETS.pathBreadcrumb.x, y: position.y + CONTENT_OFFSETS.pathBreadcrumb.y });
	let directoryActionsPosition = $derived({ x: position.x + CONTENT_OFFSETS.top.x, y: position.y + CONTENT_OFFSETS.top.y });
	let nameFilterPosition = $derived({ x: position.x + CONTENT_OFFSETS.top.x, y: position.y + CONTENT_OFFSETS.top.y + 0.05 });
	let listPosition = $derived({ x: position.x + CONTENT_OFFSETS.main.x, y: position.y + CONTENT_OFFSETS.main.y });
	let actionsPosition = $derived({ x: position.x + CONTENT_OFFSETS.side.x, y: position.y + CONTENT_OFFSETS.side.y });
	let listAreaID = $derived(`${areaID}-list`);
	let active = $derived($activeArea === listAreaID);
	let actionsActive = $derived($activeArea === `${areaID}-actions`);
	let selectedIndex = $state(0);
	// The filter the filter panel opens on.
	let initialFilterIndex = $state(0);
	let showActions = $state(false);
	let actionsScope: ReturnType<typeof NavScope> | undefined = $state();
	let showFilterPanel = $state(false);
	// Only the rows near the viewport are in the DOM; a folder can hold tens of thousands of entries.
	// shortcut: the list is as tall as all rows, so past the browser's element height limit (hundreds of thousands of rows) its end cannot be scrolled to; page the listing then.
	const OVERSCAN_ROWS = 10;
	let itemsEl: HTMLElement | undefined = $state();
	let rowHeight = $state(0);
	let listScrollTop = $state(0);
	let listHeight = $state(0);
	let currentPath = $state<string>('');
	let parentPath = $state<string | null>(null);
	let items = $state<StorageItemData[]>([]);
	let loading = $state(true);
	// Type-ahead search
	let typeAheadBuffer = $state('');
	let typeAheadTimeout: ReturnType<typeof setTimeout> | null = null;
	function handleTypedChar(char: string): void {
		if (typeAheadTimeout) clearTimeout(typeAheadTimeout);
		typeAheadBuffer += char.toLowerCase();
		typeAheadTimeout = setTimeout(() => {
			typeAheadBuffer = '';
		}, 800);
		const idx = filteredItems.findIndex(i => i.name !== '..' && i.name.toLowerCase().startsWith(typeAheadBuffer));
		if (idx >= 0) {
			selectedIndex = idx;
			showActions = false;
			scrollToSelected();
		}
	}
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
	// Save file name mode
	function getInitialSaveFileName(): string {
		return saveFileName ?? '';
	}
	let internalSaveFileName = $state(getInitialSaveFileName());
	let saveFileNameInput: ReturnType<typeof Input> | undefined = $state();
	// Name filter (FE-only): filters items in the current directory by substring match.
	let nameFilter = $state('');
	let showNameFilter = $state(false);
	let nameFilterInput: ReturnType<typeof Input> | undefined = $state();
	let filteredItems = $derived.by((): StorageItemData[] => {
		const q = nameFilter.trim().toLowerCase();
		if (!q) return items;
		return items.filter(item => item.name === '..' || item.name.toLowerCase().includes(q));
	});
	let selectedItem = $derived(filteredItems[selectedIndex]);
	// A list that is not height-limited by its page reports its whole content as its height.
	let visibleRows = $derived(rowHeight ? Math.ceil(Math.min(listHeight, window.innerHeight) / rowHeight) : 50);
	let firstRow = $derived(rowHeight ? Math.max(0, Math.min(filteredItems.length - 1, Math.floor(listScrollTop / rowHeight)) - OVERSCAN_ROWS) : 0);
	let lastRow = $derived(Math.min(filteredItems.length, firstRow + visibleRows + 2 * OVERSCAN_ROWS));

	// Rows are sized in vh, so their height is read from the first one drawn, again after a resize.
	$effect(() => {
		void listHeight;
		const row = !loading && filteredItems.length > 0 ? itemsEl?.querySelector('.row') : null;
		if (!row || !itemsEl) return;
		const firstMeasure = rowHeight === 0;
		rowHeight = row.getBoundingClientRect().height;
		// The list may have been cut short or replaced without a scroll event.
		listScrollTop = itemsEl.scrollTop;
		// The first folder is drawn before the height is known, so its selection could not be scrolled to yet.
		if (firstMeasure) tick().then(scrollToSelected);
	});

	function handleNameFilterChange(_value: string): void {
		// nameFilter is bound; just reset selection on filter change
		selectedIndex = 0;
		showActions = false;
	}
	// Directory toolbar actions
	let directoryActions = $derived(buildDirectoryActions($t, filesOnly, showAllFiles, fileFilter, fileFilterName, selectDirectoryButton, customFilter ?? undefined, currentPath, showNameFilter, !!onShare));
	// Filter panel actions
	let filterActions = $derived(buildFilterActions($t, fileFilter, fileFilterName, customFilter ?? undefined));
	let showCustomFilterDialog = $state(false);

	async function loadDirectory(path?: string, selectName?: string): Promise<void> {
		loading = true;
		error = null;
		// Reset name filter when navigating to a different directory
		nameFilter = '';
		// Set the intended path immediately so it's visible during loading
		if (path) {
			currentPath = path;
			parentPath = getParentPath(path, separator);
		}
		try {
			const options: LoadDirectoryOptions = { directoriesOnly: directoriesOnly, filesOnly, fileFilter: activeFilter };
			const result = await loadDirectoryFromAPI(path, separator, options);
			if (result.permissionDenied) {
				addNotification($t('fileBrowser.permissionDenied'));
				if (parentPath !== null) await loadDirectory(parentPath);
				return;
			}
			currentPath = result.path;
			parentPath = result.parentPath;
			items = result.items;
			// Select specific item by name, or default to first
			if (selectName) {
				const idx = result.items.findIndex(e => e.name === selectName);
				selectedIndex = idx >= 0 ? idx : 0;
			} else selectedIndex = 0;
			// Scroll to selection after DOM updates (needed when returning to parent dir)
			tick().then(() => scrollToSelected());
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
		if (!itemsEl || !rowHeight) return;
		// A glide over rows that are not drawn shows an empty list and takes seconds in a big folder, so a far row is jumped to.
		const drawn = selectedIndex >= firstRow && selectedIndex < lastRow;
		itemsEl.scrollTo({ top: selectedIndex * rowHeight - (itemsEl.clientHeight - rowHeight) / 2, behavior: drawn ? 'smooth' : 'instant' });
		// Draw the rows at the landing place now, not a frame later when the scroll event arrives.
		if (!drawn) listScrollTop = itemsEl.scrollTop;
	}

	// Keep a scroll under a stale cursor from stealing selection. While a panel is open,
	// hovering must also leave its keyboard focus and target file alone.
	function handleItemHover(index: number): void {
		if (!isMouseActive() || showActions || showFilterPanel) return;
		activateArea(listAreaID);
		selectedIndex = index;
	}

	function handleItemClick(index: number): void {
		activateArea(listAreaID);
		selectedIndex = index;
		showActions = false;
		scrollToSelected();
		activateItem(filteredItems[index]);
	}

	function activateItem(item: StorageItemData | undefined): void {
		if (!item) return;
		if (item.type === 'directory' || item.type === 'drive') navigateInto(item);
		else if (item.type === 'file') {
			if (saveFileName === undefined && !filesOnly) openActions();
			else if (!item.broken) {
				if (saveFileName !== undefined) {
					internalSaveFileName = item.name;
					onSaveFileNameChange?.(item.name);
					handleSave();
				} else onSelect?.(item.path);
			}
		}
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
		actionsScope?.controller.select([0, 0]);
		activateArea(`${areaID}-actions`);
	}

	const PAGE_SIZE = 10;

	function selectRow(index: number): void {
		selectedIndex = index;
		showActions = false;
		scrollToSelected();
	}

	function backOrUp(): void {
		if (parentPath !== null) navigateUp();
		else onBack?.();
	}

	// Each part of the browser is a declarative NavArea (NavScope); a press that leaves one names
	// the area it goes to, and false lets the area layout decide.
	// The list is one item that walks its rows itself, like the rows before; mouse rows keep their own handlers.
	const listItem: NavItem = {
		pos: [0, 0],
		onConfirm: (): void => activateItem(filteredItems[selectedIndex]),
		onNavigate(action: NavAction): boolean {
			if (action === 'left') return false;
			// Only an open actions panel lies to the right of the list.
			if (action === 'right') return !showActions;
			const last = filteredItems.length - 1;
			if (action === 'up' || action === 'down') {
				const next = selectedIndex + (action === 'up' ? -1 : 1);
				if (next < 0 || next > last) return false;
				selectRow(next);
				return true;
			}
			if (last < 0) return true;
			if (action === 'pageUp') selectRow(Math.max(0, selectedIndex - PAGE_SIZE));
			else if (action === 'pageDown') selectRow(Math.min(last, selectedIndex + PAGE_SIZE));
			else if (action === 'home') selectRow(0);
			else selectRow(last);
			return true;
		},
	};

	function listOptions(): NavAreaOptions {
		return {
			areaID: listAreaID,
			position: listPosition,
			onBack: backOrUp,
			onTypedChar: handleTypedChar,
			onUp(): string | false {
				if (error) return showPath ? `${areaID}-path` : false;
				if (showNameFilter) return `${areaID}-name-filter`;
				if (saveFileName !== undefined) return `${areaID}-save-filename`;
				return `${areaID}-directory-actions`;
			},
			onDown: (): boolean => onDownAtEnd?.() ?? false,
		};
	}

	function directoryActionsOptions(): NavAreaOptions {
		return {
			areaID: `${areaID}-directory-actions`,
			position: directoryActionsPosition,
			onBack: backOrUp,
			// Without the path breadcrumb, up goes on to the page breadcrumb through the area layout.
			onUp: (): string | false => (showPath ? `${areaID}-path` : false),
			onDown(): string {
				if (showNameFilter) return `${areaID}-name-filter`;
				if (saveFileName !== undefined) return `${areaID}-save-filename`;
				return listAreaID;
			},
		};
	}

	function nameFilterOptions(): NavAreaOptions {
		return {
			areaID: `${areaID}-name-filter`,
			position: nameFilterPosition,
			onBack(): void {
				nameFilterInput?.blur();
				backOrUp();
			},
			onUp(): string {
				nameFilterInput?.blur();
				return `${areaID}-directory-actions`;
			},
			onDown(): string {
				nameFilterInput?.blur();
				return saveFileName !== undefined ? `${areaID}-save-filename` : listAreaID;
			},
			// Left and right stay in the input, which handles the cursor.
			onLeft: (): boolean => true,
			onRight: (): boolean => true,
		};
	}

	function saveFileNameOptions(): NavAreaOptions {
		return {
			areaID: `${areaID}-save-filename`,
			position: directoryActionsPosition,
			onBack(): void {
				saveFileNameInput?.blur();
				onBack?.();
			},
			onSelect(pos: NavPos): void {
				if (pos[0] === 1) saveFileNameInput?.blur();
			},
			onUp(): string {
				saveFileNameInput?.blur();
				return showNameFilter ? `${areaID}-name-filter` : `${areaID}-directory-actions`;
			},
			onDown(): string {
				saveFileNameInput?.blur();
				return listAreaID;
			},
			// The input keeps left for its cursor and the Save button ends the row.
			onLeft: (): boolean => true,
			onRight: (): boolean => true,
		};
	}

	function closeActions(): void {
		showActions = false;
		activateArea(listAreaID);
	}

	// The two side panels hold the keyboard until they are closed.
	function actionsOptions(): NavAreaOptions {
		return { areaID: `${areaID}-actions`, position: actionsPosition, activate: true, trap: true, onBack: closeActions };
	}

	function filterOptions(): NavAreaOptions {
		return { areaID: `${areaID}-filter`, position: actionsPosition, activate: true, trap: true, initialPosition: [0, initialFilterIndex], onBack: closeFilterPanel };
	}

	// File actions from fileBrowser.ts
	let fileActions = $derived(getFileActions($t, selectFileButton, !!onShare, selectedItem?.broken));

	function handleSaveFileNameChange(value: string): void {
		internalSaveFileName = value;
		onSaveFileNameChange?.(value);
	}

	function handleAction(actionID: string): void {
		const item = filteredItems[selectedIndex];
		if (!item || item.type !== 'file') return;
		switch (actionID) {
			case 'select':
				onSelect?.(item.path);
				break;
			case 'open':
				handleOpenFile(item);
				break;
			case 'share':
				onShare?.(item.path, currentPath);
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
			case 'share':
				onShare?.(currentPath, currentPath);
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
			case 'toggleNameFilter':
				toggleNameFilter();
				break;
		}
	}

	function toggleNameFilter(): void {
		showNameFilter = !showNameFilter;
		if (!showNameFilter) {
			nameFilter = '';
			selectedIndex = 0;
		} else {
			tick().then(() => {
				activateArea(`${areaID}-name-filter`);
				nameFilterInput?.focus();
			});
		}
	}

	function openFilterPanel(): void {
		initialFilterIndex = 0;
		// Find current filter in the list to pre-select it
		if (showAllFiles) {
			const allIDx = filterActions.findIndex(a => a.id === '*');
			if (allIDx >= 0) initialFilterIndex = allIDx;
		} else if (fileFilter && fileFilter.length > 0) initialFilterIndex = 0; // Select first filter option
		// The panel's NavArea activates itself when it mounts.
		showFilterPanel = true;
	}

	function closeFilterPanel(): void {
		showFilterPanel = false;
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

	// Dialogs hold the keyboard in their own trapped NavArea, so the areas under them stay as they are.
	function openCustomFilterDialog(): void {
		showCustomFilterDialog = true;
		pushBreadcrumb($t('fileBrowser.customFilter'));
	}

	function closeCustomFilterDialog(): void {
		showCustomFilterDialog = false;
		popBreadcrumb();
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
		pushBreadcrumb($t('common.delete'));
	}

	async function confirmDeleteDirectory(): Promise<void> {
		const dirName = getCurrentDirName(currentPath, separator);
		const result = await deleteFileOrDirectory(currentPath);
		if (result.success) {
			if (dirName) addNotification($t('fileBrowser.directoryDeleted', { name: dirName }), 'warning');
			if (parentPath !== null) await loadDirectory(parentPath); // Navigate to parent after deletion
		} else error = withDetail($t('fileBrowser.deleteDirectoryFailed'), result.error);
		cancelDeleteDirectory();
	}

	async function cancelDeleteDirectory(): Promise<void> {
		showDeleteConfirm = false;
		popBreadcrumb();
		await tick();
		activateArea(`${areaID}-directory-actions`);
	}

	function showNewDirectoryDialog(): void {
		showNewDirectoryDialogState = true;
		dialogError = undefined;
		pushBreadcrumb($t('common.newDirectory'));
	}

	async function confirmNewDirectory(directoryName: string): Promise<void> {
		if (!directoryName) {
			dialogError = $t('fileBrowser.directoryNameRequired');
			return;
		}
		const newPath = joinPathWithSeparator(currentPath, directoryName, separator);
		const result = await createDirectory(newPath);
		if (result.success) {
			addNotification($t('fileBrowser.directoryCreated', { name: directoryName }), 'success');
			// Reload directory and select the new directory
			await loadDirectory(currentPath, directoryName);
			cancelNewDirectory(true); // Pass true to indicate success - focus on list
		} else dialogError = withDetail($t('fileBrowser.createDirectoryFailed'), result.error);
	}

	async function cancelNewDirectory(focusList = false): Promise<void> {
		showNewDirectoryDialogState = false;
		popBreadcrumb();
		await tick();
		// Focus on list if directory was created successfully, otherwise on toolbar
		if (focusList) activateArea(listAreaID);
		else activateArea(`${areaID}-directory-actions`);
	}

	function showCreateFileDialog(): void {
		showCreateFileDialogState = true;
		dialogError = undefined;
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
			addNotification($t('fileBrowser.fileCreated', { name: fileName }), 'success');
			// Reload directory and select the new file
			await loadDirectory(currentPath, fileName);
			cancelCreateFile(true);
		} else dialogError = withDetail($t('fileBrowser.createFileFailed'), result.error);
	}

	async function cancelCreateFile(focusList = false): Promise<void> {
		showCreateFileDialogState = false;
		popBreadcrumb();
		await tick();
		if (focusList) activateArea(listAreaID);
		else activateArea(`${areaID}-directory-actions`);
	}

	async function handleOpenFile(item: StorageItemData): Promise<void> {
		// Check for special file types (.lish, .lishs, .lishnet, .lishnets) including .gz variants
		const lowerName = item.name.toLowerCase();
		if (specialFileTypes) {
			for (const { extensions, onOpen } of specialFileTypes) {
				if (extensions.some(ext => lowerName.endsWith(ext))) {
					onOpen(item.path, currentPath, item.name);
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
		pushBreadcrumb($t('fileBrowser.deleteFile'));
	}

	async function confirmDeleteFile(): Promise<void> {
		if (!fileToDelete) return;
		const result = await deleteFileOrDirectory(fileToDelete.path);
		if (result.success) {
			addNotification($t('fileBrowser.fileDeleted', { name: fileToDelete.name }), 'warning');
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
		const breadcrumb = item.type === 'directory' ? $t('fileBrowser.renameDirectory') : $t('fileBrowser.renameFile');
		pushBreadcrumb(breadcrumb);
	}

	async function confirmRename(newName: string): Promise<void> {
		if (!itemToRename) return;
		const isCurrentDir = itemToRename.id === 'current-dir';
		const result = await renameFile(itemToRename.path, newName);
		if (result.success) {
			const key = itemToRename.type === 'directory' ? 'fileBrowser.directoryRenamed' : 'fileBrowser.fileRenamed';
			addNotification($t(key, { name: newName }), 'success');
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
		activateArea(listAreaID);
	}

	function showEditor(item: StorageItemData): void {
		// Check if file is larger than 1MB
		if (item.size && item.size > LARGE_FILE_THRESHOLD) {
			showLargeFileWarning = true;
			pendingEditFile = item;
			showActions = false;
			pushBreadcrumb($t('fileBrowser.largeFileWarning'));
			return;
		}
		openEditor(item);
	}

	function openEditor(item: StorageItemData): void {
		fileToEdit = item;
		showEditorState = true;
		showActions = false;
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
		activateArea(listAreaID);
		await tick();
		scrollToSelected();
	}

	async function closeEditor(): Promise<void> {
		showEditorState = false;
		fileToEdit = null;
		await tick();
		activateArea(listAreaID);
		await tick();
		scrollToSelected();
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
		}
		loadDirectory(path);
	}

	export function getCurrentPath(): string {
		return currentPath;
	}

	onMount(() => {
		// The sub-areas are NavScopes in the markup and registered themselves before this runs.
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
		position: relative;
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

	.type-ahead-hint {
		position: absolute;
		bottom: 1vh;
		left: 50%;
		transform: translateX(-50%);
		background: rgba(0, 0, 0, 0.85);
		color: var(--primary-foreground);
		padding: 0.5vh 2vh;
		border-radius: 0.5vh;
		font-size: 2vh;
		font-family: var(--font-mono);
		pointer-events: none;
		z-index: 10;
		border: 1px solid var(--primary-foreground);
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

	.name-filter-row {
		display: flex;
		flex-direction: row;
		gap: 1vh;
		align-items: center;
	}
</style>

<div class="browser">
	{#if showPath}
		<PathBreadcrumb areaID="{areaID}-path" position={pathBreadcrumbPosition} path={showEditorState && fileToEdit ? fileToEdit.path : currentPath} {separator} onNavigate={handleBreadcrumbNavigate} onDown={() => (showEditorState ? `${areaID}-editor` : error ? `${areaID}-list` : `${areaID}-directory-actions`)} />
	{/if}
	{#if showEditorState && fileToEdit}
		<Editor areaID="{areaID}-editor" filePath={fileToEdit.path} fileName={fileToEdit.name} {position} onBack={closeEditor} onUp={() => activateArea(`${areaID}-path`)} />
	{:else}
		<div class="content">
			{#if error}
				<Alert type="error" message={error} />
			{:else}
				<NavScope options={directoryActionsOptions()}>
					<div class="directory-actions">
						{#each directoryActions as action, index (action.id)}
							<Button label={action.label} icon={action.icon} active={action.id === 'toggleNameFilter' && showNameFilter} position={[index, 0]} onConfirm={() => handleDirectoryAction(action.id)} />
						{/each}
					</div>
				</NavScope>
				{#if showNameFilter}
					<NavScope options={nameFilterOptions()}>
						<div class="name-filter-row">
							<Input bind:this={nameFilterInput} bind:value={nameFilter} placeholder={$t('fileBrowser.filterByNamePlaceholder')} fontSize="2vh" padding="1vh 1.5vh" position={[0, 0]} onchange={handleNameFilterChange} flex />
						</div>
					</NavScope>
				{/if}
			{/if}
			{#if saveFileName !== undefined}
				<NavScope options={saveFileNameOptions()}>
					<div class="save-filename-row">
						<Input bind:this={saveFileNameInput} label={$t('common.fileName')} value={internalSaveFileName} position={[0, 0]} onchange={handleSaveFileNameChange} />
						<Button label={$t('common.save')} icon="/img/check.svg" position={[1, 0]} onConfirm={handleSave} />
					</div>
				</NavScope>
				{#if saveErrorMessage}
					<Alert type="error" message={saveErrorMessage} />
				{/if}
			{/if}
			<div class="table-row">
				<div class="container">
					<NavScope options={listOptions()} item={listItem}>
						<Table {columns} noBorder>
							<Header>
								<Cell>{$t('common.name')}</Cell>
								<Cell align="right" desktopOnly>{$t('common.size')}</Cell>
								<Cell align="right" desktopOnly>{$t('localStorage.modified')}</Cell>
							</Header>
							<div class="items" bind:this={itemsEl} bind:clientHeight={listHeight} onscroll={() => (listScrollTop = itemsEl?.scrollTop ?? 0)}>
								{#if loading}
									<div class="loading">
										<Spinner size="8vh" />
									</div>
								{:else}
									<!-- Spacers stand in for the rows that are not drawn; none after the last row, so it stays :last-child. -->
									{#if firstRow > 0}
										<div style:height="{firstRow * rowHeight}px"></div>
									{/if}
									{#each filteredItems.slice(firstRow, lastRow) as item, offset (item.id)}
										{@const index = firstRow + offset}
										<StorageItem name={item.name} type={item.type} link={item.link} broken={item.broken} size={item.size} modified={item.modified} selected={(active || actionsActive) && selectedIndex === index} isLast={index === filteredItems.length - 1} onclick={() => handleItemClick(index)} onmouseenter={() => handleItemHover(index)} />
									{/each}
									{#if lastRow < filteredItems.length}
										<div style:height="{(filteredItems.length - lastRow) * rowHeight}px"></div>
									{/if}
								{/if}
							</div>
						</Table>
					</NavScope>
					{#if typeAheadBuffer}
						<div class="type-ahead-hint">{typeAheadBuffer}</div>
					{/if}
				</div>
				{#if showActions && selectedItem?.type === 'file'}
					<NavScope bind:this={actionsScope} options={actionsOptions()}>
						<div class="actions">
							{#each fileActions as action, index (action.id)}
								<Button icon={action.icon} label={action.label} position={[0, index]} onConfirm={() => handleAction(action.id)} />
							{/each}
						</div>
					</NavScope>
				{/if}
				{#if showFilterPanel}
					<NavScope options={filterOptions()}>
						<div class="actions">
							{#each filterActions as action, index (action.id)}
								<Button icon={action.icon} label={action.label} position={[0, index]} onConfirm={() => handleFilterAction(action.id)} />
							{/each}
						</div>
					</NavScope>
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
	<InputDialog title={$t('common.newDirectory')} label={$t('fileBrowser.directoryName')} placeholder={$t('fileBrowser.enterDirectoryName')} confirmLabel={$t('common.create')} cancelLabel={$t('common.cancel')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" error={dialogError} {position} onConfirm={confirmNewDirectory} onBack={cancelNewDirectory} />
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
