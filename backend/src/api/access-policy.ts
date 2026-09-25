import { timingSafeEqual } from 'node:crypto';

/** Why a configured API token was refused; the token itself is never part of the message. */
export class InvalidTokenError extends Error {
	constructor(reason: string) {
		super(`API token ${reason}. Set LISH_TOKEN (or --token) to a random secret, for example 32 random bytes in hex.`);
		this.name = 'InvalidTokenError';
	}
}

/**
 * Refuse to run the API without a usable token. There is no unauthenticated mode: the API can
 * read, write and delete files and holds the node identity, so "no token" must never mean
 * "anyone". Leading or trailing whitespace is refused too — the login form trims what the user
 * types, so such a token could never be entered.
 */
export function assertUsableToken(token: string | undefined): asserts token is string {
	if (token === undefined || token.length === 0) throw new InvalidTokenError('is not set');
	if (token.trim().length === 0) throw new InvalidTokenError('is empty');
	if (token.trim() !== token) throw new InvalidTokenError('has leading or trailing whitespace');
}

/**
 * True when the request carries exactly one `token` query parameter equal to `expected`.
 * A duplicated parameter is refused so a proxy and the backend can never pick different ones.
 * The comparison runs in constant time; the length is not secret, so a mismatch in length
 * returns early.
 */
export function requestHasToken(url: URL, expected: string): boolean {
	const provided = url.searchParams.getAll('token');
	if (provided.length !== 1) return false;
	const a = Buffer.from(provided[0]!, 'utf8');
	const b = Buffer.from(expected, 'utf8');
	return a.length === b.length && timingSafeEqual(a, b);
}
