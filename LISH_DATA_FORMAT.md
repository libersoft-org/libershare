# LISH data structure format specification

**Version**: 1
**Created**: 24 October 2025
**Last update**: 26 October 2025

## Overview

LISH data structure format describes file and directory structures with checksums for content verification and integrity. It supports files, directories, and symbolic links with Unix-style permissions and timestamps.

## Representation

LISH data structure format defines a data structure that can be used in various forms:

- As objects in memory during runtime
- Serialized to JSON format for interchange and storage
- Stored in files (commonly with `.lish` extension when using JSON)
- Stored in databases or other persistent storage systems

This specification describes the logical structure, with JSON examples for clarity.

## LISH structure

### Root LISH object

```typescript
interface ILISH {
	version: number; // Format version (required)
	id: string; // Unique UUID for this LISH (required)
	name?: string; // LISH name (optional)
	description?: string; // Free-form text description such as author, notes, etc. (optional)
	created?: string; // ISO 8601 timestamp in UTC when LISH was created (optional)
	chunkSize: number; // Chunk size in bytes (required)
	checksumAlgo: HashAlgorithm; // Hashing algorithm used (required)
	directories?: IDirectoryEntry[]; // Array of directories (optional)
	files?: IFileEntry[]; // Array of files (optional)
	links?: ILinkEntry[]; // Array of symbolic links and hard links (optional)
}
```

### Directory entry

```typescript
interface IDirectoryEntry {
	path: string; // Relative path - e.g., "docs" or "assets/images" (required)
	permissions?: string; // Unix permissions in octal notation - e.g., "755" for rwxr-xr-x (optional)
	modified?: string; // ISO 8601 timestamp in UTC of last modification (optional)
	created?: string; // ISO 8601 timestamp in UTC of creation (optional)
}
```

### File entry

```typescript
interface IFileEntry {
	path: string; // Relative path - e.g., "docs/readme.txt" (required)
	size: number; // File size in bytes (required)
	permissions?: string; // Unix permissions in octal notation - e.g., "644" for rw-r--r-- (optional)
	modified?: string; // ISO 8601 timestamp in UTC of last modification (optional)
	created?: string; // ISO 8601 timestamp in UTC of creation (optional)
	checksums: string[]; // Array of hex-encoded checksums for each chunk (required)
}
```

### Link entry

```typescript
interface ILinkEntry {
	path: string; // Relative path of the link (required)
	target: string; // Target path (required)
	hardlink?: boolean; // True for hard links, false/undefined for symbolic links (optional, default: false)
	modified?: string; // ISO 8601 timestamp in UTC of last modification (optional)
	created?: string; // ISO 8601 timestamp in UTC of creation (optional)
}
```

**Note**:

- When `hardlink` is `true`, the `target` points to a file path in the `files` array (hard link)
- When `hardlink` is `false` or undefined, the `target` is a filesystem path (symbolic link)

## Supported hash algorithms

```typescript
type HashAlgorithm = 'sha256' | 'sha384' | 'sha512' | 'sha512-256' | 'sha3-256' | 'sha3-384' | 'sha3-512' | 'blake2b256' | 'blake2b512' | 'blake2s256';
```

## Unix permissions

File and directory permissions are stored as octal string notation representing Unix permission modes:

| Octal | Permissions | Typical Use              |
| ----- | ----------- | ------------------------ |
| "644" | rw-r--r--   | Regular files            |
| "755" | rwxr-xr-x   | Directories, executables |
| "600" | rw-------   | Private files            |
| "700" | rwx------   | Private directories      |

## Chunking

Files are divided into fixed-size chunks specified by `chunkSize` in LISH. Each chunk is hashed independently:

- The last chunk may be smaller than `chunkSize`
- Each file's `checksums` array contains one hash per chunk
- Chunks are processed sequentially from file start to end

## Example

```json
{
	"version": 1,
	"id": "34aacabb-9c6f-42a2-aaf4-61fc89c45056",
	"name": "Project Documentation",
	"description": "User manual and guides - created by John Doe",
	"created": "2025-10-24T15:30:00.000Z",
	"chunkSize": 5242880,
	"checksumAlgo": "sha256",
	"directories": [
		{
			"path": "docs",
			"permissions": "755",
			"modified": "2025-10-20T10:30:00.000Z",
			"created": "2025-10-15T08:00:00.000Z"
		},
		{
			"path": "empty-folder",
			"permissions": "755",
			"modified": "2025-10-18T12:00:00.000Z",
			"created": "2025-10-18T12:00:00.000Z"
		}
	],
	"files": [
		{
			"path": "README.md",
			"size": 1024,
			"permissions": "644",
			"modified": "2025-10-22T14:15:00.000Z",
			"created": "2025-10-20T10:30:00.000Z",
			"checksums": ["a1b2c3d4e5f6789..."]
		},
		{
			"path": "docs/manual.pdf",
			"size": 15728640,
			"permissions": "644",
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

- ✅ Directories (including empty directories)
- ✅ Files with chunked checksums
- ✅ Symbolic / hard links
- ✅ Unix file permissions (optional)
- ✅ Creation and modification timestamps
- ✅ Arbitrary chunk sizes
- ✅ Multiple hash algorithms for checksums

## Notes

- All paths in the LISH are relative to the LISH's root
- Paths use forward slashes (`/`) as separators regardless of platform
- Empty directories are explicitly listed to preserve structure
- The LISH itself is not included in the file listings
- Checksums are hex-encoded strings (lowercase)
- Timestamps must use ISO 8601 format in UTC timezone (e.g., "2025-10-24T15:30:00.000Z")
- The `directories`, `files`, and `links` arrays are optional - a LISH with no entries (empty directory structure) is valid
- The `created`, `modified`, and `permissions` fields are optional - if `permissions` is not provided, file permissions will not be modified during extraction
- If `permissions` is omitted, implementations should use default permissions for the target platform

## Version history

- **Version 1**: First version - supports files, directories, links, permissions, and timestamps
