/** Identity is compared within one filesystem; sizes must remain safe JavaScript integers. */
export interface DatasetEntryInfo {
	identity: string;
	kind: 'file' | 'directory' | 'other';
	size: number;
	links: number;
}

/** An opened file stays attached to the object checked by the caller, not its pathname. */
export interface DatasetFileHandle {
	stat(): Promise<DatasetEntryInfo>;
	read(buffer: Uint8Array, position: number): Promise<number>;
	write(buffer: Uint8Array, position: number): Promise<number>;
	truncate(size: number): Promise<void>;
	close(): Promise<void>;
}

/** Child names are single validated components; adapters never follow child links. */
export interface DatasetDirectoryHandle {
	stat(): Promise<DatasetEntryInfo>;
	openDirectory(name: string): Promise<DatasetDirectoryHandle>;
	createDirectory(name: string): Promise<DatasetDirectoryHandle>;
	openFile(name: string, mode: 'read' | 'write' | 'create'): Promise<DatasetFileHandle>;
	removeFile(name: string): Promise<void>;
	removeDirectory(name: string): Promise<void>;
	close(): Promise<void>;
}
