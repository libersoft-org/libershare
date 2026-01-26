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
 * Check if a file name passes the filter
 */
export function filePassesFilter(name: string, filter?: string[]): boolean {
	if (!filter || filter.length === 0 || filter.includes('*')) return true;
	const lowerName = name.toLowerCase();
	return filter.some(ext => lowerName.endsWith(ext.toLowerCase()));
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
	const result = await api.fsList(path);
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
	label: string;
	icon: string;
}

/**
 * Get file actions for action panel
 */
export function getFileActions(t: { fileBrowser?: { openFile?: string; deleteFile?: string }; common?: { back?: string } }): FileBrowserAction[] {
	return [
		{ id: 'open', label: t.fileBrowser?.openFile ?? 'Open', icon: '/img/folder.svg' },
		{ id: 'delete', label: t.fileBrowser?.deleteFile ?? 'Delete', icon: '/img/del.svg' },
		{ id: 'back', label: t.common?.back ?? 'Back', icon: '/img/back.svg' },
	];
}

/**
 * Build folder toolbar actions based on mode
 */
export function buildFolderActions(t: { fileBrowser?: { selectFolder?: string; newFolder?: string; deleteFolder?: string } }, filesOnly: boolean, showAllFiles: boolean, fileFilter?: string[]): FileBrowserAction[] {
	const actions: FileBrowserAction[] = [];
	if (!filesOnly) {
		actions.push({ id: 'select', label: t.fileBrowser?.selectFolder ?? 'Select', icon: '/img/check.svg' });
		actions.push({ id: 'new', label: t.fileBrowser?.newFolder ?? 'New', icon: '/img/plus.svg' });
		actions.push({ id: 'delete', label: t.fileBrowser?.deleteFolder ?? 'Delete', icon: '/img/del.svg' });
	}
	// Filter button always visible, shows current filter state
	const filterLabel = showAllFiles ? '*.*' : fileFilter && fileFilter.length > 0 ? fileFilter.join(', ') : '*.*';
	actions.push({ id: 'filter', label: filterLabel, icon: '/img/filter.svg' });
	return actions;
}

/**
 * Build filter panel actions
 */
export function buildFilterActions(t: { common?: { back?: string } }, fileFilter?: string[]): FileBrowserAction[] {
	const actions: FileBrowserAction[] = [];
	// Show all extensions as one combined option
	if (fileFilter && fileFilter.length > 0) actions.push({ id: 'filter', label: fileFilter.join(', '), icon: '/img/file.svg' });
	actions.push({ id: '*', label: '*.*', icon: '/img/file.svg' });
	actions.push({ id: 'back', label: t.common?.back ?? 'Back', icon: '/img/back.svg' });
	return actions;
}
