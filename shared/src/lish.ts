import { CodedError, ErrorCodes } from './errors.ts';
import { formatBytes } from './utils.ts';
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
	// `lish` may come straight off the wire from an untrusted peer — reject malformed shapes with
	// a coded error rather than letting a raw property access throw a native TypeError.
	if (!lish || typeof lish !== 'object') throw new CodedError(ErrorCodes.LISH_INVALID_MANIFEST, 'manifest is not an object');
	if (typeof lish.chunkSize !== 'number' || !Number.isFinite(lish.chunkSize) || lish.chunkSize <= 0) throw new CodedError(ErrorCodes.LISH_INVALID_CHUNK_SIZE, String(lish.chunkSize));
	if (lish.chunkSize > maxChunkSize) throw new CodedError(ErrorCodes.LISH_CHUNK_SIZE_TOO_LARGE, `${formatBytes(lish.chunkSize)} > ${formatBytes(maxChunkSize)}`);
	// Presence check, not truthiness: `files: null` (or any other falsy non-array) is a
	// malformed manifest, only a genuinely absent field means metadata-only.
	if (lish.files !== undefined) {
		if (!Array.isArray(lish.files)) throw new CodedError(ErrorCodes.LISH_INVALID_MANIFEST, 'files is not an array');
		for (const file of lish.files) {
			if (!file || typeof file !== 'object') throw new CodedError(ErrorCodes.LISH_INVALID_MANIFEST, 'file entry is not an object');
			const expected = file.size === 0 ? 0 : Math.ceil(file.size / lish.chunkSize);
			if (!Array.isArray(file.checksums) || file.checksums.length !== expected) {
				const got = Array.isArray(file.checksums) ? file.checksums.length : 'invalid';
				throw new CodedError(ErrorCodes.LISH_INVALID_MANIFEST, `${file.path}: expected ${expected} checksums for size ${file.size} / chunkSize ${lish.chunkSize}, got ${got}`);
			}
		}
		// A checksum names exact content, so every slot sharing it must expect the same byte
		// length — otherwise one verified payload cannot satisfy all its slots and the
		// duplicate-slot write path would write a full chunk past a shorter file tail. Only a
		// file's short last chunk can differ from chunkSize, so tracking those keeps this
		// O(#files) in memory.
		const shortLast = new Map<string, number>();
		for (const file of lish.files) {
			const rem = file.size % lish.chunkSize;
			if (file.size > 0 && rem !== 0) {
				const cs = file.checksums[file.checksums.length - 1]!;
				const prev = shortLast.get(cs);
				if (prev !== undefined && prev !== rem) throw new CodedError(ErrorCodes.LISH_INVALID_MANIFEST, `${file.path}: duplicate checksum with conflicting chunk lengths (${prev} vs ${rem})`);
				shortLast.set(cs, rem);
			}
		}
		if (shortLast.size > 0) {
			for (const file of lish.files) {
				const rem = file.size % lish.chunkSize;
				const shortLastIdx = file.size > 0 && rem !== 0 ? file.checksums.length - 1 : -1;
				for (let i = 0; i < file.checksums.length; i++) {
					if (i === shortLastIdx) continue; // consistency of short last chunks verified above
					const shortLen = shortLast.get(file.checksums[i]!);
					if (shortLen !== undefined) throw new CodedError(ErrorCodes.LISH_INVALID_MANIFEST, `${file.path}: duplicate checksum with conflicting chunk lengths (${shortLen} vs ${lish.chunkSize})`);
				}
			}
		}
	}
}

/**
 * Exact byte length of a single chunk as fixed by the manifest.
 * The last chunk of a file may be shorter than `chunkSize`. Returns -1 when the length
 * cannot be determined (no file metadata, invalid chunkSize/size, or out-of-range indices).
 */
export function expectedChunkLength(lish: ILISH, fileIndex: number, chunkIndex: number): number {
	if (!lish.files || fileIndex < 0 || fileIndex >= lish.files.length) return -1;
	if (typeof lish.chunkSize !== 'number' || !Number.isFinite(lish.chunkSize) || lish.chunkSize <= 0) return -1;
	const size = lish.files[fileIndex]!.size;
	if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return -1;
	const numChunks = size === 0 ? 0 : Math.ceil(size / lish.chunkSize);
	if (chunkIndex < 0 || chunkIndex >= numChunks) return -1;
	return Math.min(lish.chunkSize, size - chunkIndex * lish.chunkSize);
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

// Result of `lishs.list`: the summaries plus the transient per-LISH activity sets.
export interface ILISHListResult {
	items: ILISHSummary[];
	verifying: string | null;
	pendingVerification: string[];
	moving: string[];
	uploadEnabled: string[];
	downloadEnabled: string[];
}
