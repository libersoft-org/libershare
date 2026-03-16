export type StorageItemType = 'directory' | 'file' | 'drive';

export interface StorageItemData {
	id: string;
	name: string;
	path: string;
	type: StorageItemType;
	size?: number | undefined;
	modified?: string | undefined;
	hidden?: boolean | undefined;
}

// Get icon path for storage item type
export function getStorageIcon(type: StorageItemType): string {
	if (type === 'drive') return '/img/storage.svg';
	if (type === 'directory') return '/img/directory.svg';
	return '/img/file.svg';
}
