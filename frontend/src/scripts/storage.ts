export type StorageItemType = 'folder' | 'file' | 'drive';

export interface StorageItemData {
	id: string;
	name: string;
	path: string;
	type: StorageItemType;
	size?: string;
	modified?: string;
	hidden?: boolean;
}
