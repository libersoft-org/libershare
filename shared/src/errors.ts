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
	'LISH_UNSUPPORTED_CHECKSUM',
	'LISH_UNEXPECTED_ARRAY',
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

	// Downloader
	'DOWNLOADER_NOT_INITIALIZED',

	// Utils
	'INVALID_JSON',
	'MISSING_PARAMETER',
	'UNSUPPORTED_COMPRESSION',
	'UNSUPPORTED_DECOMPRESSION',
	'HTTP_ERROR',
	'INVALID_SIZE_FORMAT',

	// Download events
	'DOWNLOAD_ERROR',

	// Catalog
	'CATALOG_NOT_JOINED',
	'CATALOG_ENTRY_NOT_FOUND',
	'CATALOG_UNAUTHORIZED',
	'CATALOG_INVALID_SIGNATURE',
	'CATALOG_CLOCK_DRIFT',
	'CATALOG_REPLAY_DETECTED',
	'CATALOG_FIELD_TOO_LARGE',
	'CATALOG_TOMBSTONED',

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
