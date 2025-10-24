# LISH - LiberShare Format Specification

**Version:** 1
**Last Updated:** October 24, 2025

## Overview

LISH is a data structure format for describing file and directory structures with checksums for content verification and integrity. It supports files, directories, and symbolic links with Unix-style permissions and timestamps.

## Representation

LISH defines a data structure that can be used in various forms:

- As objects in memory during runtime
- Serialized to JSON format for interchange and storage
- Stored in files (commonly with `.lish` extension when using JSON)
- Stored in databases or other persistent storage systems

This specification describes the logical structure, with JSON examples for clarity.

## Manifest Structure

### Root Manifest Object

```typescript
interface IManifest {
	version: number; // Format version
	id: string; // Unique UUID for this manifest
	created: string; // ISO 8601 timestamp in UTC when manifest was created
	chunkSize: number; // Chunk size in bytes (global for all files)
	checksumAlgo: HashAlgorithm; // Hashing algorithm used
	directories?: IDirectoryEntry[]; // Optional array of directories
	files?: IFileEntry[]; // Optional array of files
	links?: ILinkEntry[]; // Optional array of symbolic links and hard links
}
```

### Directory Entry

```typescript
interface IDirectoryEntry {
	path: string; // Relative path (e.g., "docs" or "assets/images")
	mode: number; // Unix permissions in decimal notation (e.g., 493 = 0o755)
	modified?: string; // ISO 8601 timestamp in UTC of last modification (optional)
	created?: string; // ISO 8601 timestamp in UTC of creation (optional)
}
```

### File Entry

```typescript
interface IFileEntry {
	path: string; // Relative path (e.g., "docs/readme.txt")
	size: number; // File size in bytes
	mode: number; // Unix permissions in decimal notation (e.g., 420 = 0o644)
	modified?: string; // ISO 8601 timestamp in UTC of last modification (optional)
	created?: string; // ISO 8601 timestamp in UTC of creation (optional)
	checksums: string[]; // Array of hex-encoded checksums for each chunk
}
```

### Link Entry

```typescript
interface ILinkEntry {
	path: string; // Relative path of the link
	target: string; // Target path
	hardlink?: boolean; // True for hard links, false/undefined for symbolic links (default: false)
	modified?: string; // ISO 8601 timestamp in UTC of last modification (optional)
	created?: string; // ISO 8601 timestamp in UTC of creation (optional)
}
```

**Note:**

- When `hardlink` is `true`, the `target` points to a file path in the `files` array (hard link)
- When `hardlink` is `false` or undefined, the `target` is a filesystem path (symbolic link)

## Supported Hash Algorithms

```typescript
type HashAlgorithm = 'sha256' | 'sha512' | 'blake2b256' | 'blake2b512' | 'blake2s256' | 'shake128' | 'shake256';
```

## Unix Permissions

File and directory permissions are stored as decimal numbers representing Unix octal permission modes:

| Decimal | Octal | Permissions | Typical Use              |
| ------- | ----- | ----------- | ------------------------ |
| 420     | 0o644 | rw-r--r--   | Regular files            |
| 493     | 0o755 | rwxr-xr-x   | Directories, executables |
| 384     | 0o600 | rw-------   | Private files            |
| 448     | 0o700 | rwx------   | Private directories      |

## Chunking

Files are divided into fixed-size chunks specified by `chunkSize` in the manifest. Each chunk is hashed independently:

- The last chunk may be smaller than `chunkSize`
- Each file's `checksums` array contains one hash per chunk
- Chunks are processed sequentially from file start to end

## Example

```json
{
	"version": 1,
	"id": "34aacabb-9c6f-42a2-aaf4-61fc89c45056",
	"created": "2025-10-24T15:30:00.000Z",
	"chunkSize": 5242880,
	"checksumAlgo": "sha256",
	"directories": [
		{
			"path": "docs",
			"mode": 493,
			"modified": "2025-10-20T10:30:00.000Z",
			"created": "2025-10-15T08:00:00.000Z"
		},
		{
			"path": "empty-folder",
			"mode": 493,
			"modified": "2025-10-18T12:00:00.000Z",
			"created": "2025-10-18T12:00:00.000Z"
		}
	],
	"files": [
		{
			"path": "README.md",
			"size": 1024,
			"mode": 420,
			"modified": "2025-10-22T14:15:00.000Z",
			"created": "2025-10-20T10:30:00.000Z",
			"checksums": ["a1b2c3d4e5f6789..."]
		},
		{
			"path": "docs/manual.pdf",
			"size": 15728640,
			"mode": 420,
			"modified": "2025-10-21T09:45:00.000Z",
			"created": "2025-10-20T10:30:00.000Z",
			"checksums": ["f2960b16993b503c...", "38a4a0a7dd7fdc94...", "3a765cf06c5e6ed9..."]
		}
	],
	"links": [
		{
			"path": "docs/latest",
			"target": "manual.pdf",
			"modified": "2025-10-23T09:00:00.000Z",
			"created": "2025-10-23T09:00:00.000Z"
		},
		{
			"path": "docs/manual-copy.pdf",
			"target": "docs/manual.pdf",
			"hardlink": true,
			"modified": "2025-10-21T09:45:00.000Z",
			"created": "2025-10-21T09:45:00.000Z"
		}
	]
}
```

## Features

- ✅ Files with chunked checksums
- ✅ Directories (including empty directories)
- ✅ Symbolic links
- ✅ Hard links
- ✅ Unix file permissions (mode)
- ✅ Creation and modification timestamps
- ✅ Multiple hash algorithms
- ✅ Arbitrary chunk sizes

## Notes

- All paths in the manifest are relative to the manifest's root
- Paths use forward slashes (`/`) as separators regardless of platform
- Empty directories are explicitly listed to preserve structure
- The manifest itself is not included in the file listings
- Checksums are hex-encoded strings (lowercase)
- Timestamps must use ISO 8601 format in UTC timezone (e.g., "2025-10-24T15:30:00.000Z")
- The `directories`, `files`, and `links` arrays are optional - a manifest with no entries (empty directory structure) is valid
- The `created` and `modified` timestamps are optional - if not provided, implementations should use current time

## Version History

- **Version 1**: First version - supports files, directories, symlinks / hardlinks, permissions, and timestamps
