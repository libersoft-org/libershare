// Error codes sent from backend to frontend.
// Frontend translates these to localized messages via the language system.

const errorCodes = [
	// RPC / Server
	'PARSE_ERROR',
	'METHOD_REQUIRED',
	'UNKNOWN_METHOD',

	// LISH
	'LISH_NOT_FOUND',
	'NO_LISHS',
	'DIRECTORY_EMPTY',
	'LISH_ALREADY_EXISTS',
	'INVALID_INPUT_TYPE',
	'LISH_INVALID_FORMAT',
	'LISH_MISSING_ID',
	'LISH_MISSING_CREATED',
	'LISH_INVALID_CHUNK_SIZE',
	'LISH_CHUNK_SIZE_TOO_LARGE',
	'LISH_INVALID_MANIFEST',
	'LISH_UNSUPPORTED_CHECKSUM',
	'LISH_UNEXPECTED_ARRAY',
	'LISH_CREATE_CANCELLED',
	'PATH_ACCESS_DENIED',
	'INVALID_FILE_INDEX',

	// Network
	'NETWORK_NOT_FOUND',
	'NO_NETWORKS',
	'NETWORK_NOT_JOINED',
	'NETWORK_NOT_RUNNING',
	'NETWORK_INVALID',
	'NO_VALID_NETWORKS',
	'NETWORK_NOT_STARTED',
	'NETWORK_PORT_IN_USE',

	// Peers
	'PEER_UNREACHABLE',
	'PEER_LISH_NOT_SHARED',
	'PEER_CHUNK_NOT_FOUND',
	'PEER_BUSY',
	'PEER_IO_ERROR',
	'PEER_INVALID_REQUEST',

	// Downloader
	'DOWNLOADER_NOT_INITIALIZED',
	'DOWNLOAD_CANCELLED',
	'IO_NOT_FOUND',
	'DIRECTORY_ACCESS_DENIED',
	'DISK_FULL',

	// Filesystem (FileBrowser)
	'FS_NOT_FOUND',
	'FS_ACCESS_DENIED',
	'FS_NOT_PERMITTED',
	'FS_ALREADY_EXISTS',
	'FS_NOT_EMPTY',
	'FS_IS_DIRECTORY',
	'FS_NOT_DIRECTORY',
	'FS_BUSY',
	'FS_NO_SPACE',
	'FS_READ_ONLY',
	'FS_NAME_TOO_LONG',
	'FS_TOO_MANY_OPEN',
	'FS_INVALID',
	'FS_CROSS_DEVICE',
	'FS_NOT_SUPPORTED',
	'FS_IO',
	'FS_TOO_MANY_LINKS',
	'FS_FILE_TOO_LARGE',
	'FS_TIMEOUT',
	'FS_ERROR',

	// Utils
	'INVALID_JSON',
	'INVALID_SETTINGS_BACKUP',
	'MISSING_PARAMETER',
	'UNSUPPORTED_COMPRESSION',
	'UNSUPPORTED_DECOMPRESSION',
	'HTTP_ERROR',
	'INVALID_SIZE_FORMAT',

	// Download events
	'DOWNLOAD_ERROR',

	// Internal (catch-all for uncoded errors)
	'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof errorCodes)[number];
export const ErrorCodes: { [K in ErrorCode]: K } = Object.fromEntries(errorCodes.map(c => [c, c])) as { [K in ErrorCode]: K };

/**
 * Error subclass carrying a machine-readable code and an optional detail string.
 * Backend throws these; the RPC layer serialises { error, detail? } on the wire.
 */
export class CodedError extends Error {
	readonly code: ErrorCode;
	readonly detail?: string | undefined;

	constructor(code: ErrorCode, detail?: string) {
		super(detail ? `${code}: ${detail}` : code);
		this.code = code;
		this.detail = detail;
	}
}
