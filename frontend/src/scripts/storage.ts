export type StorageItemType = 'directory' | 'file' | 'drive';

export interface StorageItemData {
	id: string;
	name: string;
	path: string;
	type: StorageItemType;
	size?: number | undefined;
	modified?: string | undefined;
	hidden?: boolean | undefined;
	/** Symbolic link or junction; `type` describes the target. */
	link?: boolean | undefined;
	/** Link whose target is missing; it cannot be opened. */
	broken?: boolean | undefined;
}

// Get icon path for storage item type
export function getStorageIcon(type: StorageItemType, link = false): string {
	if (type === 'drive') return '/img/storage.svg';
	if (type === 'directory') return link ? '/img/directory-link.svg' : '/img/directory.svg';
	return link ? '/img/file-link.svg' : '/img/file.svg';
}
