import { CodedError, ErrorCodes, type ErrorCode } from '@shared';

/** Client operations of the LISH protocol whose replies carry an error envelope. */
export type LISHOperation = 'getChunk' | 'getLish' | 'getLishs' | 'announceHave' | 'searchResult';

/**
 * Error codes a remote peer may answer each operation with — exactly what the serving side
 * sends. PEER_INVALID_REQUEST is always possible: it is the reply to an unparsable or unknown
 * request. A code outside the set — a local code such as LISH_CHUNK_SIZE_TOO_LARGE that callers
 * treat as terminal, or an arbitrary string — is the peer lying, not an answer.
 */
const REMOTE_ERRORS: Readonly<Record<LISHOperation, ReadonlySet<ErrorCode>>> = {
	getChunk: new Set([ErrorCodes.PEER_INVALID_REQUEST, ErrorCodes.PEER_LISH_NOT_SHARED, ErrorCodes.PEER_BUSY, ErrorCodes.PEER_CHUNK_NOT_FOUND, ErrorCodes.PEER_IO_ERROR]),
	getLish: new Set([ErrorCodes.PEER_INVALID_REQUEST, ErrorCodes.PEER_LISH_NOT_SHARED]),
	getLishs: new Set([ErrorCodes.PEER_INVALID_REQUEST, ErrorCodes.PEER_LISTING_NOT_AUTHORIZED]),
	announceHave: new Set([ErrorCodes.PEER_INVALID_REQUEST]),
	searchResult: new Set([ErrorCodes.PEER_INVALID_REQUEST]),
};

/** Success fields; an envelope carrying one of them next to `error` is ambiguous. */
const SUCCESS_FIELDS = ['manifest', 'data', 'lishs', 'ok', 'ready'] as const;

const MAX_ERROR_CODE_LENGTH = 64;

/**
 * Check the shape of a decoded peer reply and return the remote error it carries, if any.
 * A malformed envelope — not a plain object, `error` that is not an own short ASCII string
 * from the operation's set, or `error` next to a success field — throws PEER_INVALID_REQUEST.
 * The diagnostic is built only from `context`, a bounded local description; nothing of the
 * peer's reply is copied into it.
 */
export function readRemoteError(response: unknown, operation: LISHOperation, context: string): ErrorCode | undefined {
	const invalid = (why: string): CodedError => new CodedError(ErrorCodes.PEER_INVALID_REQUEST, `${context}: ${why}`);
	if (response === null || typeof response !== 'object' || Array.isArray(response) || ArrayBuffer.isView(response)) throw invalid('response is not an object');
	if (!Object.prototype.hasOwnProperty.call(response, 'error')) return undefined;
	const code = (response as Record<string, unknown>)['error'];
	if (typeof code !== 'string' || code.length > MAX_ERROR_CODE_LENGTH || !/^[A-Z0-9_]+$/.test(code) || !REMOTE_ERRORS[operation].has(code as ErrorCode)) throw invalid('unexpected error code');
	if (SUCCESS_FIELDS.some(field => Object.prototype.hasOwnProperty.call(response, field))) throw invalid('error reply also carries a result');
	return code as ErrorCode;
}
