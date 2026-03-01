export type LISHid = string;
export type ChunkID = string;

export const SUPPORTED_ALGOS = ['sha256', 'sha384', 'sha512', 'sha512-256', 'sha3-256', 'sha3-384', 'sha3-512', 'blake2b256', 'blake2b512', 'blake2s256'] as const;
export type HashAlgorithm = (typeof SUPPORTED_ALGOS)[number];
export const DEFAULT_ALGO: HashAlgorithm = 'sha256';
export const DEFAULT_CHUNK_SIZE: number = 1024 * 1024;

export interface ILISH {
	id: string;
	name?: string | undefined;
	description?: string | undefined;
	created: string;
	chunkSize: number;
	checksumAlgo: HashAlgorithm;
	directories?: IDirectoryEntry[];
	files?: IFileEntry[];
	links?: ILinkEntry[];
}

// Extended interface for LISHs stored locally in the app (lishs.json)
export interface IStoredLISH extends ILISH {
	directory?: string;
	chunks?: string[];
}

export interface IDirectoryEntry {
	path: string;
	permissions?: string;
	modified?: string;
	created?: string;
}

export interface IFileEntry {
	path: string;
	size: number;
	permissions?: string;
	modified?: string;
	created?: string;
	checksums: string[];
}

export interface ILinkEntry {
	path: string;
	target: string;
	hardlink?: boolean;
	modified?: string;
	created?: string;
}

// Summary for the download list table (lightweight, no files/chunks)
export type LISHSortField = 'created' | 'name' | 'totalSize' | 'fileCount';
export type SortOrder = 'asc' | 'desc';

export interface ILISHSummary {
	id: string;
	name?: string | undefined;
	description?: string | undefined;
	created: string;
	totalSize: number;
	fileCount: number;
	directoryCount: number;
}

// Detail for the download detail view (files without checksums, no chunks)
export interface ILISHDetailFile {
	path: string;
	size: number;
	permissions?: string | undefined;
	modified?: string | undefined;
	created?: string | undefined;
}

export interface ILISHDetail {
	id: string;
	name?: string | undefined;
	description?: string | undefined;
	created: string;
	chunkSize: number;
	checksumAlgo: HashAlgorithm;
	totalSize: number;
	fileCount: number;
	directoryCount: number;
	directory?: string | undefined;
	files: ILISHDetailFile[];
	directories: IDirectoryEntry[];
	links: ILinkEntry[];
}
