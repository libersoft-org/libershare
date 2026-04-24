import { decode as lpDecode } from 'it-length-prefixed';
import { encode as lpEncode } from 'it-length-prefixed';
import { type Stream } from '@libp2p/interface';
import { type LISHid, type ChunkID, type ErrorCode, ErrorCodes, CodedError } from '@shared';
import { type DataServer } from '../lish/data-server.ts';
import { Uint8ArrayList } from 'uint8arraylist';
import { uploadLimiter } from './speed-limiter.ts';
import { isBusy } from '../api/busy.ts';
import { trace } from '../logger.ts';
import { registerUploadPeer, unregisterUploadPeer, recordUploadBytes, type ConnectionType } from './peer-tracker.ts';
import { encode as codecEncode, decode as codecDecode } from './codec.ts';
export const LISH_PROTOCOL = '/lish/0.0.1';
export type LISHRequest = LISHGetChunkRequest | LISHGetLishRequest | LISHGetLishsRequest | LISHAnnounceHaveRequest;
export interface LISHGetChunkRequest {
	type?: 'getChunk';
	lishID: LISHid;
	chunkID: ChunkID;
}
export interface LISHGetLishRequest {
	type: 'getLish';
	lishID: LISHid;
}
export interface LISHGetLishsRequest {
	type: 'getLishs';
}
/**
 * Unicast "I have this LISH" announcement — response to a pubsub `want`.
 * Sent over a fresh LISH protocol stream from seeder → requester; small (no chunk data, no manifest).
 * `multiaddrs` carries the seeder's dial addresses so the requester can open a chunk-transfer connection.
 */
export interface LISHAnnounceHaveRequest {
	type: 'announceHave';
	lishID: LISHid;
	chunks: HaveChunks;
	multiaddrs: string[];
}
// Discriminated responses: always exactly one of { data | manifest | lishs } OR { error }.
export type LISHGetChunkResponse =
	| { data: Uint8Array } // raw binary chunk data (msgpack native bin type, no base64)
	| { error: ErrorCode };
export type LISHGetLishResponse = { manifest: import('@shared').IStoredLISH } | { error: ErrorCode };
export type LISHGetLishsResponse = { type: 'getLishs-result'; lishs: Array<{ id: string; name?: string; totalSize?: number }> } | { type: 'getLishs-result'; error: ErrorCode };
export type LISHAnnounceHaveResponse = { ok: true } | { error: ErrorCode };
export type HaveChunks = 'all' | ChunkID[];

/**
 * Incoming HAVE announcement payload handed to the Downloader registered for the given lishID.
 * `peerID` is the remote end of the stream (verified by libp2p), NOT a field from the wire —
 * this removes the spoofing vector the old pubsub HaveMessage had.
 */
export interface HaveAnnouncement {
	lishID: string;
	peerID: string;
	multiaddrs: string[];
	chunks: HaveChunks;
}
type HaveAnnouncementHandler = (ann: HaveAnnouncement) => void;
const haveAnnouncementHandlers = new Map<string, HaveAnnouncementHandler>();

/** Register a handler for incoming unicast HAVE announcements for a given lishID. Only one handler per lishID. */
export function registerHaveAnnouncementHandler(lishID: string, handler: HaveAnnouncementHandler): void {
	haveAnnouncementHandlers.set(lishID, handler);
}
export function unregisterHaveAnnouncementHandler(lishID: string): void {
	haveAnnouncementHandlers.delete(lishID);
}

// Client-side stream wrapper that can send multiple requests
export class LISHClient {
	private stream: Stream;
	private decoder: AsyncGenerator<Uint8Array | Uint8ArrayList>;
	// TODO: is haveChunks still used? review whether this belongs here
	public haveChunks!: HaveChunks;
	constructor(stream: Stream) {
		this.stream = stream;
		// Chunk response ≈ chunkSize + small msgpack overhead; manifest can be large for many-file LISHs.
		this.decoder = lpDecode(stream, { maxDataLength: 8 * 1024 * 1024 });
	}

	// Safely parse a peer response. Maps malformed wire bytes / incompatible-protocol responses
	// onto PEER_INVALID_REQUEST so callers can rely purely on CodedError.
	private parseResponse<T>(raw: Uint8Array, detail: string): T {
		let parsed: unknown;
		try {
			parsed = codecDecode(raw);
		} catch {
			throw new CodedError(ErrorCodes.PEER_INVALID_REQUEST, `${detail}: malformed response`);
		}
		if (parsed === null || typeof parsed !== 'object') {
			throw new CodedError(ErrorCodes.PEER_INVALID_REQUEST, `${detail}: response is not an object`);
		}
		return parsed as T;
	}

	// Request full LISH manifest from peer
	async requestManifest(lishID: LISHid): Promise<import('@shared').IStoredLISH> {
		const request: LISHGetLishRequest = { type: 'getLish', lishID };
		sendLengthPrefixed(this.stream, codecEncode(request));
		const responseMsg = (await Promise.race([this.decoder.next(), rejectAfterTimeout(30000, 'manifest-receive')])) as IteratorResult<Uint8Array | Uint8ArrayList>;
		if (responseMsg.done || !responseMsg.value) throw new CodedError(ErrorCodes.PEER_UNREACHABLE, lishID);
		const responseData = responseMsg.value instanceof Uint8ArrayList ? responseMsg.value.subarray() : responseMsg.value;
		const response = this.parseResponse<LISHGetLishResponse>(responseData, `getLish ${lishID}`);
		if ('error' in response) throw new CodedError(response.error, lishID);
		if (!('manifest' in response)) throw new CodedError(ErrorCodes.PEER_INVALID_REQUEST, `getLish ${lishID}: missing manifest`);
		return response.manifest;
	}

	// Request list of shared LISHs from peer
	async requestList(): Promise<Array<{ id: string; name?: string; totalSize?: number }>> {
		const request: LISHGetLishsRequest = { type: 'getLishs' };
		sendLengthPrefixed(this.stream, codecEncode(request));
		const responseMsg = (await Promise.race([this.decoder.next(), rejectAfterTimeout(15000, 'list-receive')])) as IteratorResult<Uint8Array | Uint8ArrayList>;
		if (responseMsg.done || !responseMsg.value) throw new CodedError(ErrorCodes.PEER_UNREACHABLE);
		const responseData = responseMsg.value instanceof Uint8ArrayList ? responseMsg.value.subarray() : responseMsg.value;
		const response = this.parseResponse<LISHGetLishsResponse>(responseData, 'getLishs');
		if ('error' in response) throw new CodedError(response.error);
		if (!('lishs' in response)) throw new CodedError(ErrorCodes.PEER_INVALID_REQUEST, 'getLishs: missing lishs');
		return response.lishs;
	}

	// Request a single chunk (can be called multiple times on same stream)
	async requestChunk(lishID: LISHid, chunkID: ChunkID): Promise<Uint8Array> {
		// Bail early if stream is already closed/aborted — treat as transient (peer unreachable),
		// not as a reason to permanently ban the peer.
		if (this.stream.status !== 'open') {
			throw new CodedError(ErrorCodes.PEER_UNREACHABLE, `${lishID}: stream ${this.stream.status}`);
		}
		const request: LISHGetChunkRequest = {
			type: 'getChunk',
			lishID,
			chunkID,
		};
		sendLengthPrefixed(this.stream, codecEncode(request));
		// Read the response (with timeout — prevents hanging on dead/aborted streams)
		const responseMsg = (await Promise.race([this.decoder.next(), rejectAfterTimeout(30000, 'receive')])) as IteratorResult<Uint8Array | Uint8ArrayList>;
		if (responseMsg.done || !responseMsg.value) throw new CodedError(ErrorCodes.PEER_UNREACHABLE, lishID);
		const responseData = responseMsg.value instanceof Uint8ArrayList ? responseMsg.value.subarray() : responseMsg.value;
		const response = this.parseResponse<LISHGetChunkResponse>(responseData, `getChunk ${lishID}/${chunkID}`);
		if ('error' in response) throw new CodedError(response.error, `${lishID}/${chunkID}`);
		if (!('data' in response) || !(response.data instanceof Uint8Array)) throw new CodedError(ErrorCodes.PEER_INVALID_REQUEST, `getChunk ${lishID}/${chunkID}: missing data`);
		return response.data;
	}

	// Close the stream when done
	async close(): Promise<void> {
		try {
			await this.stream.close();
		} catch (error) {
			// Ignore errors on close
		}
	}

	/**
	 * Send a unicast HAVE announcement (replaces the old pubsub broadcast).
	 * Fire-and-forget in spirit, but waits briefly for the ACK so the caller knows the write landed.
	 */
	async announceHave(lishID: LISHid, chunks: HaveChunks, multiaddrs: string[]): Promise<void> {
		const request: LISHAnnounceHaveRequest = { type: 'announceHave', lishID, chunks, multiaddrs };
		sendLengthPrefixed(this.stream, codecEncode(request));
		const responseMsg = (await Promise.race([this.decoder.next(), rejectAfterTimeout(15000, 'announceHave-receive')])) as IteratorResult<Uint8Array | Uint8ArrayList>;
		if (responseMsg.done || !responseMsg.value) throw new CodedError(ErrorCodes.PEER_UNREACHABLE, lishID);
		const responseData = responseMsg.value instanceof Uint8ArrayList ? responseMsg.value.subarray() : responseMsg.value;
		const response = this.parseResponse<LISHAnnounceHaveResponse>(responseData, `announceHave ${lishID}`);
		if ('error' in response) throw new CodedError(response.error, lishID);
	}
}

export function setMaxUploadSpeed(kbPerSec: number): void {
	uploadLimiter.setLimit(kbPerSec);
}

/**
 * Global per-LISH upload peer cap. 0 = unlimited. Enforced on the first chunk
 * request for a given LISH on a stream — if already at cap, the request is
 * rejected with PEER_BUSY (transient; client retries later via its own
 * peer-discovery cycle).
 */
let maxUploadPeersPerLISH = 30;

export function setMaxUploadPeersPerLISH(n: number): void {
	maxUploadPeersPerLISH = Math.max(0, Math.floor(n));
}

type BroadcastFn = (event: string, data: any) => void;
let broadcastFn: BroadcastFn | null = null;
// Per-LISH upload tracking
const activeUploads = new Map<string, { chunks: number; startTime: number; bytes: number; peers: number; speedSamples: { time: number; bytes: number }[] }>();
// Per-LISH active stream count
const activeStreamCount = new Map<string, number>();

export function setUploadBroadcast(fn: BroadcastFn): void {
	broadcastFn = fn;
}
export function getActiveUploads(): Map<string, { chunks: number; startTime: number; bytes: number; peers: number; speedSamples: { time: number; bytes: number }[] }> {
	return activeUploads;
}

/** Reset all module-level upload state. For use in tests only. */
export function resetUploadState(): void {
	activeUploads.clear();
	activeStreamCount.clear();
	uploadEnabled.clear();
	uploadLimiter.setLimit(0);
	uploadLimiter.reset();
	maxUploadPeersPerLISH = 30;
	broadcastFn = null;
}

// Per-LISH upload enabled/paused — persisted to DB, default=paused
const uploadEnabled = new Set<string>();
let persistUploadState: ((lishID: string, enabled: boolean) => void) | null = null;
// Recovery hooks — set by transfer.ts to trigger download recovery on upload I/O errors
let startRecoveryFn: ((lishID: string, errorCode: string, prev: { downloadEnabled: boolean; uploadEnabled: boolean }) => void) | null = null;
let isDownloadEnabled: ((lishID: string) => boolean) | null = null;
let triggerVerifyFn: ((lishID: string) => void) | null = null;
export function setUploadRecoveryHooks(recoveryFn: typeof startRecoveryFn, downloadEnabledFn: typeof isDownloadEnabled, verifyFn?: typeof triggerVerifyFn): void {
	startRecoveryFn = recoveryFn;
	isDownloadEnabled = downloadEnabledFn;
	triggerVerifyFn = verifyFn ?? null;
}

export function initUploadState(enabledLishs: Set<string>, persistFn: (lishID: string, enabled: boolean) => void): void {
	uploadEnabled.clear();
	for (const id of enabledLishs) uploadEnabled.add(id);
	persistUploadState = persistFn;
	console.log(`[Upload] ${uploadEnabled.size} LISHs enabled`);
}
export function disableUpload(lishID: string): void {
	uploadEnabled.delete(lishID);
	persistUploadState?.(lishID, false);
	broadcastFn?.('transfer.upload:disabled', { lishID });
}
export function enableUpload(lishID: string): void {
	uploadEnabled.add(lishID);
	persistUploadState?.(lishID, true);
	broadcastFn?.('transfer.upload:enabled', { lishID });
}
export function isUploadDisabled(lishID: string): boolean {
	return !uploadEnabled.has(lishID);
}
export function isUploadEnabled(lishID: string): boolean {
	return uploadEnabled.has(lishID);
}
export function getEnabledUploads(): Set<string> {
	return uploadEnabled;
}
/** Remove in-memory upload state without DB persist (for LISH deletion). */
export function removeUploadState(lishID: string): void {
	uploadEnabled.delete(lishID);
	broadcastFn?.('transfer.upload:disabled', { lishID });
}

const IO_ERROR_THRESHOLD = 3; // consecutive I/O errors before auto-disabling upload

export async function handleLISHProtocol(stream: Stream, dataServer: DataServer, remotePeerID?: string, connectionType?: ConnectionType): Promise<void> {
	const servedLishIDs = new Set<string>();
	const ioErrorCounts = new Map<string, number>(); // per-LISH consecutive I/O error counter
	const remotePeer = remotePeerID?.slice(0, 12) ?? 'unknown';
	const fullRemotePeer = remotePeerID ?? 'unknown';
	const connType: ConnectionType = connectionType ?? 'DIRECT';
	trace(`[PROTO] stream open from ${remotePeer}, id=${stream.id}`);
	let requestCount = 0;
	try {
		// Wrap the stream with length-prefixed decoder for multiple messages
		// requests are small (<200 bytes); 8MB covers edge cases with large manifests
		const decoder = lpDecode(stream, { maxDataLength: 8 * 1024 * 1024 });
		// Handle multiple requests on the same stream
		for await (const msg of decoder) {
			requestCount++;
			const data = msg instanceof Uint8ArrayList ? msg.subarray() : msg;
			trace(`[PROTO] #${requestCount} from ${remotePeer}: ${data.byteLength}B`);
			// Safely parse the request — peer might send binary garbage, malformed payload, a different protocol, etc.
			// In that case reply with PEER_INVALID_REQUEST and continue with the next message on the stream.
			let request: LISHRequest;
			try {
				const parsed: unknown = codecDecode(data);
				if (parsed === null || typeof parsed !== 'object') throw new Error('request is not an object');
				request = parsed as LISHRequest;
			} catch (parseErr: any) {
				// console.debug(`[PROTO] malformed request from ${remotePeer}: ${parseErr.message ?? parseErr}`);
				const response: LISHGetChunkResponse = { error: ErrorCodes.PEER_INVALID_REQUEST };
				sendLengthPrefixed(stream, codecEncode(response));
				continue;
			}

			if (request.type === 'getLishs') {
				// Return list of all shared (upload_enabled) LISHs — id and name only.
				// Newest first — matches the order shown locally in "Download and Sharing".
				const allLishs = dataServer.list();
				const shared = allLishs.filter(l => uploadEnabled.has(l.id)).reverse();
				const response: LISHGetLishsResponse = {
					type: 'getLishs-result',
					lishs: shared.map(l => {
						const totalSize = (l.files ?? []).reduce((sum, f) => sum + f.size, 0);
						const entry: { id: string; name?: string; totalSize?: number } = { id: l.id, totalSize };
						if (l.name !== undefined) entry.name = l.name;
						return entry;
					}),
				};
				sendLengthPrefixed(stream, codecEncode(response));
			} else if (request.type === 'getLish') {
				// Only return manifest for LISHs with upload enabled
				if (!uploadEnabled.has(request.lishID)) {
					const response: LISHGetLishResponse = { error: ErrorCodes.PEER_LISH_NOT_SHARED };
					sendLengthPrefixed(stream, codecEncode(response));
				} else {
					const lish = dataServer.get(request.lishID as LISHid);
					if (!lish || !lish.directory) {
						// We advertise it as shared (upload_enabled) but have no meta/directory — inconsistent local state.
						// Return NOT_SHARED (same code as the deliberate-reject case) to avoid leaking whether we have the LISH.
						const response: LISHGetLishResponse = { error: ErrorCodes.PEER_LISH_NOT_SHARED };
						sendLengthPrefixed(stream, codecEncode(response));
					} else {
						const { directory, chunks, ...exportData } = lish;
						const manifest = exportData as import('@shared').IStoredLISH;
						const response: LISHGetLishResponse = { manifest };
						sendLengthPrefixed(stream, codecEncode(response));
					}
				}
			} else if (request.type === 'getChunk' || request.type === undefined) {
				// Chunk request (type may be omitted for legacy compatibility)
				const chunkReq = request as LISHGetChunkRequest;
				if (!uploadEnabled.has(chunkReq.lishID)) {
					const blockedResponse: LISHGetChunkResponse = { error: ErrorCodes.PEER_LISH_NOT_SHARED };
					sendLengthPrefixed(stream, codecEncode(blockedResponse));
					continue;
				}
				if (isBusy(chunkReq.lishID)) {
					// Transient — client should retry later.
					const blockedResponse: LISHGetChunkResponse = { error: ErrorCodes.PEER_BUSY };
					sendLengthPrefixed(stream, codecEncode(blockedResponse));
					continue;
				}
				// Per-LISH upload peer cap — check BEFORE the disk read so a cap-reached stream
				// doesn't fan out into expensive I/O. Transient PEER_BUSY so the remote retries later.
				if (!servedLishIDs.has(chunkReq.lishID) && maxUploadPeersPerLISH > 0 && (activeStreamCount.get(chunkReq.lishID) ?? 0) >= maxUploadPeersPerLISH) {
					const busyResponse: LISHGetChunkResponse = { error: ErrorCodes.PEER_BUSY };
					sendLengthPrefixed(stream, codecEncode(busyResponse));
					continue;
				}
				const chunkResult = await dataServer.getChunk(chunkReq.lishID, chunkReq.chunkID);
				if (chunkResult === 'lish_not_found') {
					// Same privacy rationale as getLish: don't leak whether we have it.
					const response: LISHGetChunkResponse = { error: ErrorCodes.PEER_LISH_NOT_SHARED };
					sendLengthPrefixed(stream, codecEncode(response));
					continue;
				}
				if (chunkResult === 'chunk_not_found') {
					// Partial seeder — peer simply doesn't have this chunk. Client should go elsewhere.
					const response: LISHGetChunkResponse = { error: ErrorCodes.PEER_CHUNK_NOT_FOUND };
					sendLengthPrefixed(stream, codecEncode(response));
					continue;
				}
				if (chunkResult === 'io_error') {
					// Track consecutive I/O errors per LISH
					const count = (ioErrorCounts.get(chunkReq.lishID) ?? 0) + 1;
					ioErrorCounts.set(chunkReq.lishID, count);
					const errResponse: LISHGetChunkResponse = { error: ErrorCodes.PEER_IO_ERROR };
					sendLengthPrefixed(stream, codecEncode(errResponse));
					if (count >= IO_ERROR_THRESHOLD && uploadEnabled.has(chunkReq.lishID)) {
						console.error(`[Upload] ${chunkReq.lishID.slice(0, 8)}: ${count} consecutive I/O errors — auto-disabling upload`);
						const wasDownloadEnabled = isDownloadEnabled?.(chunkReq.lishID) ?? false;
						disableUpload(chunkReq.lishID);
						dataServer.setError(chunkReq.lishID as LISHid, ErrorCodes.IO_NOT_FOUND, `Upload I/O error`);
						broadcastFn?.('transfer.upload:error', { lishID: chunkReq.lishID, error: ErrorCodes.IO_NOT_FOUND, errorDetail: 'Upload source directory not accessible' });
						// Trigger recovery — includes download re-enable if was enabled, or just verify if not
						if (startRecoveryFn) startRecoveryFn(chunkReq.lishID, ErrorCodes.IO_NOT_FOUND, { downloadEnabled: wasDownloadEnabled, uploadEnabled: true });
						// Always trigger verification to update DB state (even without download)
						if (triggerVerifyFn) triggerVerifyFn(chunkReq.lishID);
					}
					continue;
				}
				const chunkData = chunkResult;
				// Register upload peer on first chunk request for this LISH, regardless of chunk availability.
				// This ensures peers appear in the tracker even if the first requested chunk is missing.
				if (!servedLishIDs.has(chunkReq.lishID)) {
					servedLishIDs.add(chunkReq.lishID);
					activeStreamCount.set(chunkReq.lishID, (activeStreamCount.get(chunkReq.lishID) ?? 0) + 1);
					if (remotePeerID) registerUploadPeer(chunkReq.lishID, fullRemotePeer, connType);
				}
				// Send raw binary chunk — msgpack native bin type, no base64.
				const response: LISHGetChunkResponse = { data: chunkData };
				sendLengthPrefixed(stream, codecEncode(response));
				ioErrorCounts.delete(chunkReq.lishID); // reset on success
				const chunkLoc = dataServer.findChunkFile(chunkReq.lishID as LISHid, chunkReq.chunkID as import('@shared').ChunkID);
				if (remotePeerID) recordUploadBytes(chunkReq.lishID, fullRemotePeer, chunkData.length, chunkLoc);
				dataServer.incrementUploadedBytes(chunkReq.lishID as import('@shared').LISHid, chunkData.length);
				await uploadLimiter.throttle(chunkData.length);
				// Upload progress tracking (sliding window speed, 1s polling)
				if (broadcastFn) {
					let info = activeUploads.get(chunkReq.lishID);
					if (!info) {
						info = { chunks: 0, startTime: Date.now(), bytes: 0, peers: 0, speedSamples: [] };
						activeUploads.set(chunkReq.lishID, info);
					}
					info.chunks++;
					info.bytes += chunkData.length;
					info.peers = activeStreamCount.get(chunkReq.lishID) ?? 1;
					const now = Date.now();
					info.speedSamples.push({ time: now, bytes: chunkData.length });
					// Prune samples older than 10s
					const cutoff = now - 10000;
					let pruneIdx = 0;
					while (pruneIdx < info.speedSamples.length && info.speedSamples[pruneIdx]!.time <= cutoff) pruneIdx++;
					if (pruneIdx > 0) info.speedSamples.splice(0, pruneIdx);
					const windowBytes = info.speedSamples.reduce((sum: number, s: any) => sum + s.bytes, 0);
					const oldestTime = info.speedSamples.length > 1 ? info.speedSamples[0]!.time : now;
					const elapsed = (now - oldestTime) / 1000;
					const bytesPerSecond = elapsed >= 0.5 ? Math.round(windowBytes / elapsed) : 0;
					broadcastFn('transfer.upload:progress', { lishID: chunkReq.lishID, uploadedChunks: info.chunks, bytesPerSecond, peers: info.peers });
				}
			} else if (request.type === 'announceHave') {
				// Unicast HAVE announcement from a seeder in response to our pubsub WANT.
				// Dispatch to the registered Downloader (if any) — peerID is the verified stream remote,
				// NOT a field from the wire, so it can't be spoofed.
				const handler = haveAnnouncementHandlers.get(request.lishID);
				if (handler && remotePeerID) {
					try {
						handler({
							lishID: request.lishID,
							peerID: remotePeerID,
							multiaddrs: Array.isArray(request.multiaddrs) ? request.multiaddrs : [],
							chunks: request.chunks,
						});
					} catch (err: any) {
						console.warn(`[PROTO] announceHave handler error for ${request.lishID.slice(0, 8)}: ${err?.message ?? err}`);
					}
				}
				const response: LISHAnnounceHaveResponse = { ok: true };
				sendLengthPrefixed(stream, codecEncode(response));
			} else {
				// Unknown request type — reject with PEER_INVALID_REQUEST
				const response: LISHGetChunkResponse = { error: ErrorCodes.PEER_INVALID_REQUEST };
				sendLengthPrefixed(stream, codecEncode(response));
			}
		}
		// Stream closed by remote, close our end
		await stream.close();
	} catch (error: any) {
		console.debug(`[PROTO] stream error from ${remotePeer} after ${requestCount} reqs: ${error.message?.slice(0, 120) ?? error}`);
		stream.abort(error instanceof Error ? error : new Error(String(error)));
	} finally {
		trace(`[PROTO] stream closed for ${remotePeer}, served ${requestCount} reqs, lishIDs: ${[...servedLishIDs].map(id => id.slice(0, 8)).join(',')}`);
		// Unregister upload peer + decrement stream count per LISH
		for (const lishID of servedLishIDs) {
			unregisterUploadPeer(lishID, fullRemotePeer);
			const count = (activeStreamCount.get(lishID) ?? 1) - 1;
			if (count <= 0) {
				activeStreamCount.delete(lishID);
				activeUploads.delete(lishID);
				broadcastFn?.('transfer.upload:stopped', { lishID });
			} else {
				activeStreamCount.set(lishID, count);
				const info = activeUploads.get(lishID);
				if (info) info.peers = count;
			}
		}
	}
}

// Helper: reject after timeout (prevents hanging on dead streams).
// Uses PEER_UNREACHABLE so callers (downloader) treat timeouts as transient rather than permanently banning the peer.
function rejectAfterTimeout(ms: number, label: string): Promise<never> {
	return new Promise((_, reject) => setTimeout(() => reject(new CodedError(ErrorCodes.PEER_UNREACHABLE, `${label} timeout >${ms}ms`)), ms));
}

// Helper to send a length-prefixed message (single atomic send — no inter-chunk race window)
function sendLengthPrefixed(stream: Stream, data: Uint8Array): void {
	stream.send(lpEncode.single(data));
}
