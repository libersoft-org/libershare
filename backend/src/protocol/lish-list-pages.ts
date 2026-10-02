import { CodedError, ErrorCodes, type IStoredLISH } from '@shared';
import { encode, decode } from './codec.ts';
import { MAX_LIST_RESPONSE_SIZE } from './constants.ts';
import { readRemoteError } from './lish-response.ts';

export interface LISHListEntry {
	id: string;
	name?: string;
	totalSize?: number;
}

export interface LISHListRequest {
	type: 'getLishs';
	query?: string;
	page?: true;
	cursor?: string;
}

interface Snapshot {
	id: string;
	query: string | undefined;
	entries: LISHListEntry[];
	next: number;
	deadline: number;
}

const LIST_TIMEOUT_MS = 15000;
const CURSOR = /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}):([1-9][0-9]{0,15})$/u;

function invalid(): CodedError {
	return new CodedError(ErrorCodes.PEER_INVALID_REQUEST, 'getLishs: invalid pagination');
}

function entries(list: readonly IStoredLISH[], query: string | undefined, advertised: (id: string) => boolean): LISHListEntry[] {
	const q = query?.toLowerCase();
	return list.filter(lish => advertised(lish.id) && (!q || lish.id.toLowerCase().includes(q) || lish.name?.toLowerCase().includes(q))).reverse().map(lish => ({
		id: lish.id,
		...(lish.name !== undefined ? { name: lish.name } : {}),
		totalSize: (lish.files ?? []).reduce((sum, file) => sum + file.size, 0),
	}));
}

/** Only the current listing on this stream owns a cursor; a fresh query replaces it. */
export class LISHListPages {
	private snapshot: Snapshot | undefined;

	clear(): void {
		this.snapshot = undefined;
	}

	respond(request: LISHListRequest, list: () => IStoredLISH[], advertised: (id: string) => boolean, frameLimit: number = MAX_LIST_RESPONSE_SIZE): Uint8Array {
		if ((request.page !== undefined && request.page !== true) || (request.query !== undefined && typeof request.query !== 'string') || (request.cursor !== undefined && (request.page !== true || typeof request.cursor !== 'string'))) throw invalid();
		if (request.page !== true) {
			this.clear();
			const all = entries(list(), request.query, advertised);
			let size = encode({ type: 'getLishs-result', lishs: [] }).byteLength + (all.length < 16 ? 0 : all.length < 65536 ? 2 : 4);
			for (const entry of all) {
				size += encode(entry).byteLength;
				if (size > frameLimit) throw new CodedError(ErrorCodes.PEER_LIST_TOO_LARGE);
			}
			return encode({ type: 'getLishs-result', lishs: all });
		}
		let snapshot = this.snapshot;
		if (request.cursor === undefined) {
			snapshot = { id: crypto.randomUUID(), query: request.query, entries: entries(list(), request.query, advertised), next: 0, deadline: Date.now() + LIST_TIMEOUT_MS };
			this.snapshot = snapshot;
		} else if (!snapshot || Date.now() >= snapshot.deadline || request.query !== snapshot.query || request.cursor !== `${snapshot.id}:${snapshot.next}`) {
			this.clear();
			throw invalid();
		}
		const selected = snapshot!;
		const offset = selected.next;
		const page: LISHListEntry[] = [];
		// The largest cursor/offset and array header cover the real envelope without repeatedly encoding the page.
		let size = encode({ type: 'getLishs-result', lishs: [], page: true, offset: Number.MAX_SAFE_INTEGER, nextCursor: `${selected.id}:${Number.MAX_SAFE_INTEGER}` }).byteLength + 4;
		while (selected.next < selected.entries.length) {
			const entry = selected.entries[selected.next]!;
			if (!advertised(entry.id)) { selected.next++; continue; }
			const bytes = encode(entry).byteLength;
			if (size + bytes > frameLimit) {
				if (page.length === 0) { this.clear(); throw new CodedError(ErrorCodes.PEER_LIST_TOO_LARGE); }
				break;
			}
			page.push(entry);
			size += bytes;
			selected.next++;
		}
		const nextCursor = selected.next < selected.entries.length ? `${selected.id}:${selected.next}` : undefined;
		const reply = encode({ type: 'getLishs-result', lishs: page, page: true, offset, ...(nextCursor ? { nextCursor } : {}) });
		if (reply.byteLength > frameLimit) { this.clear(); throw new CodedError(ErrorCodes.PEER_LIST_TOO_LARGE); }
		if (!nextCursor) this.clear();
		return reply;
	}
}

function listEntries(value: unknown): LISHListEntry[] {
	if (!Array.isArray(value)) throw invalid();
	for (const entry of value) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry) || ArrayBuffer.isView(entry) || typeof entry.id !== 'string' || entry.id.length === 0 || (entry.name !== undefined && typeof entry.name !== 'string') || (entry.totalSize !== undefined && (!Number.isSafeInteger(entry.totalSize) || entry.totalSize < 0))) throw invalid();
	}
	return value as LISHListEntry[];
}

async function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return pending;
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(new CodedError(ErrorCodes.PEER_UNREACHABLE, 'getLishs: cancelled'));
		signal.addEventListener('abort', onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
	try { return await Promise.race([pending, aborted]); }
	finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}

/** No partial list escapes on malformed, cancelled or over-budget multi-page replies. */
export async function receiveLISHList(query: string | undefined, exchange: (request: LISHListRequest, timeoutMs: number) => Promise<Uint8Array>, maxBytes: number, signal?: AbortSignal): Promise<LISHListEntry[]> {
	const deadline = Date.now() + LIST_TIMEOUT_MS;
	const result: LISHListEntry[] = [];
	const ids = new Set<string>();
	let received = 0;
	let cursor: string | undefined;
	let snapshotID: string | undefined;
	let expectedOffset = 0;
	for (;;) {
		if (signal?.aborted) throw new CodedError(ErrorCodes.PEER_UNREACHABLE, 'getLishs: cancelled');
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new CodedError(ErrorCodes.PEER_UNREACHABLE, 'getLishs: timeout');
		const raw = await abortable(exchange({ type: 'getLishs', page: true, ...(query !== undefined ? { query } : {}), ...(cursor ? { cursor } : {}) }, remaining), signal);
		received += raw.byteLength;
		if (received > maxBytes) throw new CodedError(ErrorCodes.PEER_LIST_TOO_LARGE);
		let reply: Record<string, unknown>;
		try {
			const decoded: unknown = decode(raw);
			const error = readRemoteError(decoded, 'getLishs', 'getLishs');
			if (error) throw new CodedError(error);
			reply = decoded as Record<string, unknown>;
		} catch (error) {
			if (error instanceof CodedError) throw error;
			throw invalid();
		}
		if (reply['type'] !== 'getLishs-result') throw invalid();
		const page = listEntries(reply['lishs']);
		if (reply['page'] === undefined) {
			if (cursor !== undefined || reply['nextCursor'] !== undefined || reply['offset'] !== undefined) throw invalid();
		} else {
			if (reply['page'] !== true || !Number.isSafeInteger(reply['offset']) || reply['offset'] !== expectedOffset) throw invalid();
			const next = reply['nextCursor'];
			if (next !== undefined) {
				if (typeof next !== 'string' || page.length === 0) throw invalid();
				const match = CURSOR.exec(next);
				if (!match || (snapshotID && snapshotID !== match[1])) throw invalid();
				const offset = Number(match[2]);
				if (!Number.isSafeInteger(offset) || offset <= expectedOffset || offset < expectedOffset + page.length) throw invalid();
				snapshotID = match[1];
				expectedOffset = offset;
			}
		}
		for (const entry of page) {
			if (ids.has(entry.id)) throw invalid();
			ids.add(entry.id);
			result.push(entry);
		}
		if (reply['nextCursor'] === undefined) return result;
		cursor = reply['nextCursor'] as string;
	}
}
