import { api } from './api.ts';
import type { StorageItemData } from './storage.ts';
import { formatSize, formatDate } from './utils.ts';
/**
 * File system entry from API
 */
export interface FsEntry {
	name: string;
	path: string;
	type: 'file' | 'directory' | 'drive';
	size?: number;
	modified?: string;
	hidden?: boolean;
}

/**
 * Get parent path from a given path
 */
export function getParentPath(path: string, separator: string): string | null {
	if (!path || path === separator) return null;
	if (/^[A-Z]:\\?$/i.test(path)) return '';
	const parts = path.split(separator).filter(Boolean);
	if (parts.length <= 1) {
		if (separator === '\\' && /^[A-Z]:/i.test(path)) return parts[0] + '\\';
		return separator === '/' ? '/' : '';
	}
	const parent = parts.slice(0, -1).join(separator);
	return separator === '/' ? '/' + parent : parent;
}

/**
 * Convert wildcard pattern to RegExp
 * * = any characters, ? = single character
 */
function wildcardToRegex(pattern: string): RegExp {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special regex chars (except * and ?)
		.replace(/\*/g, '.*') // * = any characters
		.replace(/\?/g, '.'); // ? = single character
	return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Check if a file name passes the filter
 * Supports wildcard patterns: * (any chars), ? (single char)
 * Examples: *.mkv, *.mkv*, video*.mp4, file?.txt
 */
export function filePassesFilter(name: string, filter?: string[]): boolean {
	if (!filter || filter.length === 0 || filter.includes('*') || filter.includes('*.*')) return true;
	return filter.some(pattern => wildcardToRegex(pattern).test(name));
}

/**
 * Transform FsEntry from API to StorageItemData for UI
 */
export function transformFsEntry(entry: FsEntry, index: number): StorageItemData {
	return {
		id: String(index + 1),
		name: entry.name,
		path: entry.path,
		type: entry.type === 'directory' ? 'folder' : entry.type,
		size: formatSize(entry.size),
		modified: formatDate(entry.modified),
		hidden: entry.hidden,
	};
}

/**
 * Filter options for loadDirectory
 */
export interface LoadDirectoryOptions {
	foldersOnly?: boolean;
	filesOnly?: boolean;
	fileFilter?: string[];
}

/**
 * Result from loadDirectory
 */
export interface LoadDirectoryResult {
	path: string;
	parentPath: string | null;
	items: StorageItemData[];
	separator: string;
}

/**
 * Load directory contents from API
 */
export async function loadDirectoryFromApi(path: string | undefined, separator: string, options: LoadDirectoryOptions = {}): Promise<LoadDirectoryResult> {
	const { foldersOnly = false, filesOnly = false, fileFilter } = options;
	const result = await api.fs.list(path);
	const currentPath = result.path;
	const parentPath = getParentPath(currentPath, separator);
	let entries: StorageItemData[] = result.entries.map((entry: FsEntry, index: number) => transformFsEntry(entry, index));
	// Filter entries based on mode
	if (foldersOnly) entries = entries.filter(e => e.type === 'folder' || e.type === 'drive');
	else if (filesOnly)
		entries = entries.filter(e => e.type === 'folder' || e.type === 'drive' || (e.type === 'file' && filePassesFilter(e.name, fileFilter))); // Keep folders for navigation, but filter files by extension
	else if (fileFilter && fileFilter.length > 0 && !fileFilter.includes('*')) entries = entries.filter(e => e.type === 'folder' || e.type === 'drive' || (e.type === 'file' && filePassesFilter(e.name, fileFilter))); // Filter files by extension but keep folders
	// Add ".." entry if we have a parent
	if (parentPath !== null) {
		entries.unshift({
			id: '0',
			name: '..',
			path: parentPath || '',
			type: 'folder',
		});
	}

	return {
		path: currentPath,
		parentPath,
		items: entries,
		separator,
	};
}

/**
 * Create fallback parent entry for error state
 */
export function createParentEntry(parentPath: string): StorageItemData {
	return {
		id: '0',
		name: '..',
		path: parentPath || '',
		type: 'folder',
	};
}

/**
 * Check if path is at root level
 */
export function isAtRoot(path: string, separator: string): boolean {
	return !path || path === separator || (separator === '/' && path === '/');
}

/**
 * Get current directory name from path
 */
export function getCurrentDirName(path: string, separator: string): string | undefined {
	return path.split(separator).filter(Boolean).pop();
}

/**
 * File browser action definition
 */
export interface FileBrowserAction {
	id: string;
	label?: string;
	icon: string;
}

/**
 * Get file actions for action panel
 */
export function getFileActions(t: { fileBrowser?: { openFile?: string; editFile?: string; renameFile?: string; deleteFile?: string }; common?: { back?: string } }): FileBrowserAction[] {
	return [
		{ id: 'open', label: t.fileBrowser?.openFile, icon: '/img/folder.svg' },
		{ id: 'edit', label: t.fileBrowser?.editFile, icon: '/img/edit.svg' },
		{ id: 'rename', label: t.fileBrowser?.renameFile, icon: '/img/edit.svg' },
		{ id: 'delete', label: t.fileBrowser?.deleteFile, icon: '/img/del.svg' },
		{ id: 'back', label: t.common?.back, icon: '/img/back.svg' },
	];
}

/**
 * Build folder toolbar actions based on mode
 */
export function buildFolderActions(t: { fileBrowser?: { selectFolder?: string; newFolder?: string; deleteFolder?: string; createFile?: string } }, filesOnly: boolean, showAllFiles: boolean, fileFilter?: string[], selectable?: boolean, customFilter?: string): FileBrowserAction[] {
	const actions: FileBrowserAction[] = [];
	if (!filesOnly) {
		if (selectable) actions.push({ id: 'select', label: t.fileBrowser?.selectFolder, icon: '/img/check.svg' });
		actions.push({ id: 'new', label: t.fileBrowser?.newFolder, icon: '/img/plus.svg' });
		actions.push({ id: 'delete', label: t.fileBrowser?.deleteFolder, icon: '/img/del.svg' });
	}
	actions.push({ id: 'createFile', label: t.fileBrowser?.createFile, icon: '/img/file.svg' });
	// Filter button always visible, shows current filter state
	let filterLabel: string;
	if (customFilter) filterLabel = customFilter;
	else if (showAllFiles) filterLabel = '*.*';
	else if (fileFilter && fileFilter.length > 0) filterLabel = fileFilter.join(', ');
	else filterLabel = '*.*';
	actions.push({ id: 'filter', label: filterLabel, icon: '/img/filter.svg' });
	return actions;
}

/**
 * Build filter panel actions
 */
export function buildFilterActions(t: { common?: { back?: string }; fileBrowser?: { customFilter?: string } }, fileFilter?: string[], customFilter?: string): FileBrowserAction[] {
	const actions: FileBrowserAction[] = [];
	// Show all extensions as one combined option
	if (fileFilter && fileFilter.length > 0) actions.push({ id: 'filter', label: fileFilter.join(', '), icon: '/img/file.svg' });
	actions.push({ id: '*', label: '*.*', icon: '/img/file.svg' });
	// Custom filter - show current value in parentheses if set
	const customLabel = customFilter ? `${t.fileBrowser?.customFilter} (${customFilter})` : t.fileBrowser?.customFilter;
	actions.push({ id: 'custom', label: customLabel, icon: '/img/filter.svg' });
	actions.push({ id: 'back', label: t.common?.back, icon: '/img/back.svg' });
	return actions;
}

// ============================================================================
// Path Breadcrumb
// ============================================================================

export interface PathBreadcrumbItem {
	id: string;
	name: string;
	path: string;
	icon?: string;
}

/**
 * Parse a file path into breadcrumb items
 */
export function parsePathToBreadcrumbs(path: string, separator: string): PathBreadcrumbItem[] {
	if (!path) return [{ id: '0', name: separator === '/' ? '/' : 'Drives', path: '', icon: '/img/storage.svg' }];
	const parts = path.split(separator).filter(Boolean);
	const items: PathBreadcrumbItem[] = [];
	if (separator === '/') {
		// Linux: start with root "/"
		items.push({ id: '0', name: '/', path: '/', icon: '/img/storage.svg' });
		let currentPath = '';
		for (let i = 0; i < parts.length; i++) {
			currentPath += '/' + parts[i];
			items.push({ id: String(i + 1), name: parts[i], path: currentPath });
		}
	} else {
		// Windows: start with drive list, then drive, then folders
		items.push({ id: '0', name: 'Drives', path: '', icon: '/img/storage.svg' });
		let currentPath = '';
		for (let i = 0; i < parts.length; i++) {
			if (i === 0) {
				// Drive letter (e.g., "C:")
				currentPath = parts[i] + separator;
				items.push({ id: String(i + 1), name: parts[i], path: currentPath });
			} else {
				currentPath += parts[i];
				items.push({ id: String(i + 1), name: parts[i], path: currentPath });
				if (i < parts.length - 1) currentPath += separator;
			}
		}
	}
	return items;
}

// ============================================================================
// File/Folder CRUD Operations
// ============================================================================

export interface FileOperationResult {
	success: boolean;
	error?: string;
}

/**
 * Delete a file or folder
 */
export async function deleteFileOrFolder(path: string): Promise<FileOperationResult> {
	try {
		await api.fs.delete(path);
		return { success: true };
	} catch (e: any) {
		return { success: false, error: e.message || 'Failed to delete' };
	}
}

/**
 * Create a new folder
 */
export async function createFolder(path: string): Promise<FileOperationResult> {
	try {
		await api.fs.mkdir(path);
		return { success: true };
	} catch (e: any) {
		return { success: false, error: e.message || 'Failed to create folder' };
	}
}

/**
 * Open a file with system default application
 */
export async function openFile(path: string): Promise<FileOperationResult> {
	try {
		await api.fs.open(path);
		return { success: true };
	} catch (e: any) {
		return { success: false, error: e.message || 'Failed to open file' };
	}
}

/**
 * Rename a file
 */
export async function renameFile(path: string, newName: string): Promise<FileOperationResult> {
	try {
		await api.fs.rename(path, newName);
		return { success: true };
	} catch (e: any) {
		return { success: false, error: e.message || 'Failed to rename file' };
	}
}

/**
 * Get file system info (separator, etc.)
 */
export async function getFileSystemInfo(): Promise<{ separator: string; home?: string }> {
	const info = await api.fs.info();
	return info;
}

/**
 * Join path segments with separator
 */
export function joinPathWithSeparator(basePath: string, name: string, separator: string): string {
	if (!basePath) return name;
	if (basePath.endsWith(separator)) return basePath + name;
	return basePath + separator + name;
}
