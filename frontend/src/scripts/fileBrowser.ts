import { api } from './api.ts';
import { type StorageItemData } from './storage.ts';
import { formatDate } from './utils.ts';
import { tt, withDetail, translateError } from './language.ts';
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
 * Split a path into directory and file name components
 * Handles both forward slashes and backslashes
 */
export function splitPath(path: string, defaultDirectory: string = ''): { directory: string; fileName: string | undefined } {
	const trimmed = path.trim();
	if (!trimmed) return { directory: defaultDirectory, fileName: undefined };
	// Find last separator (try both / and \)
	const lastSlash = trimmed.lastIndexOf('/');
	const lastBackslash = trimmed.lastIndexOf('\\');
	const lastSep = Math.max(lastSlash, lastBackslash);
	const sep = lastBackslash > lastSlash ? '\\' : '/';
	if (lastSep >= 0) {
		return {
			directory: trimmed.substring(0, lastSep) || sep,
			fileName: trimmed.substring(lastSep + 1) || undefined,
		};
	}
	// No separator - treat whole path as file name if it looks like a file, otherwise directory
	return { directory: defaultDirectory, fileName: trimmed };
}

/**
 * Join directory path with file name
 */
export function joinPath(directory: string, fileName: string): string {
	const sep = directory.includes('\\') ? '\\' : '/';
	// Remove trailing separator from directory if present
	const cleanDirectory = directory.endsWith(sep) ? directory.slice(0, -1) : directory;
	return cleanDirectory + sep + fileName;
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
	if (separator === '/') return '/' + parent;
	// Windows: ensure drive root has trailing backslash (C: → C:\)
	if (/^[A-Z]:$/i.test(parent)) return parent + '\\';
	return parent;
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
		type: entry.type === 'directory' ? 'directory' : entry.type,
		size: entry.size,
		modified: formatDate(entry.modified),
		hidden: entry.hidden,
	};
}

/**
 * Filter options for loadDirectory
 */
export interface LoadDirectoryOptions {
	directoriesOnly?: boolean | undefined;
	filesOnly?: boolean | undefined;
	fileFilter?: string[] | undefined;
}

/**
 * Result from loadDirectory
 */
export interface LoadDirectoryResult {
	path: string;
	parentPath: string | null;
	items: StorageItemData[];
	separator: string;
	permissionDenied?: boolean;
}

/**
 * Load directory contents from API
 */
export async function loadDirectoryFromAPI(path: string | undefined, separator: string, options: LoadDirectoryOptions = {}): Promise<LoadDirectoryResult> {
	const { directoriesOnly: directoriesOnly = false, filesOnly = false, fileFilter } = options;
	const result = await api.fs.list(path);
	if (result.error) {
		const currentPath = result.path;
		const parentPath = getParentPath(currentPath, separator);
		return { path: currentPath, parentPath, items: [], separator, permissionDenied: true };
	}
	const currentPath = result.path;
	const parentPath = getParentPath(currentPath, separator);
	let entries: StorageItemData[] = result.entries.map((entry: FsEntry, index: number) => transformFsEntry(entry, index));
	// Filter entries based on mode
	if (directoriesOnly) entries = entries.filter(e => e.type === 'directory' || e.type === 'drive');
	else if (filesOnly)
		entries = entries.filter(e => e.type === 'directory' || e.type === 'drive' || (e.type === 'file' && filePassesFilter(e.name, fileFilter))); // Keep directories for navigation, but filter files by extension
	else if (fileFilter && fileFilter.length > 0 && !fileFilter.includes('*')) entries = entries.filter(e => e.type === 'directory' || e.type === 'drive' || (e.type === 'file' && filePassesFilter(e.name, fileFilter))); // Filter files by extension but keep directories
	// Add ".." entry if we have a parent
	if (parentPath !== null) {
		entries.unshift({
			id: '0',
			name: '..',
			path: parentPath || '',
			type: 'directory',
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
		type: 'directory',
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
export function getFileActions(t: (key: string) => string, selectFileButton?: boolean): FileBrowserAction[] {
	const actions: FileBrowserAction[] = [];
	if (selectFileButton) actions.push({ id: 'select', label: t('fileBrowser.selectFile'), icon: '/img/check.svg' });
	actions.push({ id: 'open', label: t('fileBrowser.openFile'), icon: '/img/directory.svg' });
	actions.push({ id: 'edit', label: t('fileBrowser.editFile'), icon: '/img/edit.svg' });
	actions.push({ id: 'rename', label: t('fileBrowser.renameFile'), icon: '/img/edit.svg' });
	actions.push({ id: 'delete', label: t('fileBrowser.deleteFile'), icon: '/img/del.svg' });
	actions.push({ id: 'back', label: t('common.back'), icon: '/img/back.svg' });
	return actions;
}

/**
 * Build directory toolbar actions based on mode
 */
export function buildDirectoryActions(t: (key: string) => string, filesOnly: boolean, showAllFiles: boolean, fileFilter?: string[], fileFilterName?: string, selectDirectoryButton?: boolean, customFilter?: string, currentPath?: string): FileBrowserAction[] {
	const actions: FileBrowserAction[] = [];
	const isDriveList = currentPath === '' || currentPath === undefined;
	if (!filesOnly && !isDriveList) {
		if (selectDirectoryButton) actions.push({ id: 'select', label: t('fileBrowser.selectDirectory'), icon: '/img/check.svg' });
		actions.push({ id: 'new', label: t('fileBrowser.newDirectory'), icon: '/img/plus.svg' });
		actions.push({ id: 'rename', label: t('fileBrowser.renameDirectory'), icon: '/img/edit.svg' });
		actions.push({ id: 'delete', label: t('fileBrowser.deleteDirectory'), icon: '/img/del.svg' });
	}
	if (!isDriveList) actions.push({ id: 'createFile', label: t('fileBrowser.createFile'), icon: '/img/plus.svg' });
	// Filter button always visible, shows current filter state
	let filterLabel: string;
	if (customFilter) filterLabel = customFilter;
	else if (showAllFiles) filterLabel = '*.*';
	else if (fileFilter && fileFilter.length > 0) filterLabel = fileFilterName ?? fileFilter.join(', ');
	else filterLabel = '*.*';
	actions.push({ id: 'filter', label: filterLabel, icon: '/img/filter.svg' });
	return actions;
}

/**
 * Build filter panel actions
 */
export function buildFilterActions(t: (key: string) => string, fileFilter?: string[], fileFilterName?: string, customFilter?: string): FileBrowserAction[] {
	const actions: FileBrowserAction[] = [];
	// Show all extensions as one combined option
	if (fileFilter && fileFilter.length > 0) actions.push({ id: 'filter', label: fileFilterName ?? fileFilter.join(', '), icon: '/img/file.svg' });
	actions.push({ id: '*', label: '*.*', icon: '/img/file.svg' });
	// Custom filter - show current value in parentheses if set
	const customLabel = customFilter ? `${t('fileBrowser.customFilter')} (${customFilter})` : t('fileBrowser.customFilter');
	actions.push({ id: 'custom', label: customLabel, icon: '/img/filter.svg' });
	actions.push({ id: 'back', label: t('common.back'), icon: '/img/back.svg' });
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
			currentPath += '/' + parts[i]!;
			items.push({ id: String(i + 1), name: parts[i]!, path: currentPath });
		}
	} else {
		// Windows: start with drive list, then drive, then directories
		items.push({ id: '0', name: 'Drives', path: '', icon: '/img/storage.svg' });
		let currentPath = '';
		for (let i = 0; i < parts.length; i++) {
			if (i === 0) {
				// Drive letter (e.g., "C:")
				currentPath = parts[i]! + separator;
				items.push({ id: String(i + 1), name: parts[i]!, path: currentPath });
			} else {
				currentPath += parts[i]!;
				items.push({ id: String(i + 1), name: parts[i]!, path: currentPath });
				if (i < parts.length - 1) currentPath += separator;
			}
		}
	}
	return items;
}

// ============================================================================
// File/Directory CRUD Operations
// ============================================================================

export interface FileOperationResult {
	success: boolean;
	error?: string;
}

/**
 * Delete a file or directory
 */
export async function deleteFileOrDirectory(path: string): Promise<FileOperationResult> {
	try {
		await api.fs.delete(path);
		return { success: true };
	} catch (e: any) {
		return { success: false, error: withDetail(tt('fileBrowser.deleteFailed'), translateError(e)) };
	}
}

/**
 * Create a new directory
 */
export async function createDirectory(path: string): Promise<FileOperationResult> {
	try {
		await api.fs.mkdir(path);
		return { success: true };
	} catch (e: any) {
		return { success: false, error: withDetail(tt('fileBrowser.createDirectoryFailed'), translateError(e)) };
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
		return { success: false, error: withDetail(tt('fileBrowser.openFileFailed'), translateError(e)) };
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
		return { success: false, error: withDetail(tt('fileBrowser.renameFileFailed'), translateError(e)) };
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
