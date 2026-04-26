import { CodedError, ErrorCodes } from './errors.ts';
export type LISHid = string;
export type ChunkID = string;
export const SUPPORTED_ALGOS = ['sha256', 'sha384', 'sha512', 'sha512-256', 'sha3-256', 'sha3-384', 'sha3-512', 'blake2b256', 'blake2b512', 'blake2s256'] as const;
export type HashAlgorithm = (typeof SUPPORTED_ALGOS)[number];
export const DEFAULT_ALGO: HashAlgorithm = 'sha256';
export const DEFAULT_CHUNK_SIZE: number = 1024 * 1024;

/**
 * Validate chunkSize bounds and manifest consistency.
 * Throws CodedError on the first violation.
 *
 * Rules:
 *  - chunkSize must be a positive number not exceeding maxChunkSize
 *  - for every file: checksums.length must equal ceil(size / chunkSize)
 *    (zero-size files have zero checksums)
 */
export function validateLISHStructure(lish: ILISH, maxChunkSize: number): void {
	if (typeof lish.chunkSize !== 'number' || !Number.isFinite(lish.chunkSize) || lish.chunkSize <= 0) throw new CodedError(ErrorCodes.LISH_INVALID_CHUNK_SIZE, String(lish.chunkSize));
	if (lish.chunkSize > maxChunkSize) throw new CodedError(ErrorCodes.LISH_CHUNK_SIZE_TOO_LARGE, `${lish.chunkSize} > ${maxChunkSize}`);
	if (lish.files) {
		for (const file of lish.files) {
			const expected = file.size === 0 ? 0 : Math.ceil(file.size / lish.chunkSize);
			if (!Array.isArray(file.checksums) || file.checksums.length !== expected) {
				const got = Array.isArray(file.checksums) ? file.checksums.length : 'invalid';
				throw new CodedError(ErrorCodes.LISH_INVALID_MANIFEST, `${file.path}: expected ${expected} checksums for size ${file.size} / chunkSize ${lish.chunkSize}, got ${got}`);
			}
		}
	}
}

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
	// Target directory where the LISH should be moved after download completes.
	// Only set while downloading into temp; cleared once moved to final.
	finalDirectory?: string;
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
	verifiedChunks: number;
	totalChunks: number;
	totalUploadedBytes: number;
	totalDownloadedBytes: number;
	errorCode?: string | undefined;
	errorDetail?: string | undefined;
}
// Detail for the download detail view (files without checksums, no chunks)
export interface ILISHDetailFile {
	path: string;
	size: number;
	permissions?: string | undefined;
	modified?: string | undefined;
	created?: string | undefined;
	verifiedChunks: number;
	totalChunks: number;
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
	verifiedChunks: number;
	totalChunks: number;
	totalUploadedBytes: number;
	totalDownloadedBytes: number;
}
