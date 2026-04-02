import { decode } from 'it-length-prefixed';
import { encode as lpEncode } from 'it-length-prefixed';
import { type Stream } from '@libp2p/interface';
import { type LISHid, type ChunkID } from '@shared';
import { type DataServer } from '../lish/data-server.ts';
import { Uint8ArrayList } from 'uint8arraylist';
import { uploadLimiter } from './speed-limiter.ts';
import { isBusy } from '../api/busy.ts';
export const LISH_PROTOCOL = '/lish/1.0.0';
export type LISHRequest = LISHChunkRequest | LISHManifestRequest;
export interface LISHChunkRequest {
	type?: 'chunk';
	lishID: LISHid;
	chunkID: ChunkID;
}
export interface LISHManifestRequest {
	type: 'manifest';
	lishID: LISHid;
}
export interface LISHResponse {
	data: string | null; // base64-encoded binary chunk data (per LISH protocol spec)
}
export interface LISHManifestResponse {
	manifest: import('@shared').IStoredLISH | null;
}
export type HaveChunks = 'all' | ChunkID[];

// Client-side stream wrapper that can send multiple requests
export class LISHClient {
	private stream: Stream;
	private decoder: AsyncGenerator<Uint8Array | Uint8ArrayList>;
	// TODO: is haveChunks still used? review whether this belongs here
	public haveChunks!: HaveChunks;
	constructor(stream: Stream) {
		this.stream = stream;
		this.decoder = decode(stream);
	}

	// Request full LISH manifest from peer
	async requestManifest(lishID: LISHid): Promise<import('@shared').IStoredLISH | null> {
		try {
			const request: LISHManifestRequest = { type: 'manifest', lishID };
			const requestData = new TextEncoder().encode(JSON.stringify(request));
			sendLengthPrefixed(this.stream, requestData);
			const responseMsg = await Promise.race([
				this.decoder.next(),
				rejectAfterTimeout(30000, 'manifest-receive'),
			]) as IteratorResult<Uint8Array | Uint8ArrayList>;
			if (responseMsg.done || !responseMsg.value) return null;
			const responseData = responseMsg.value instanceof Uint8ArrayList ? responseMsg.value.subarray() : responseMsg.value;
			const response: LISHManifestResponse = JSON.parse(new TextDecoder().decode(responseData));
			return response.manifest;
		} catch (error) {
			console.error('Error requesting manifest:', error);
			return null;
		}
	}

	// Request a single chunk (can be called multiple times on same stream)
	async requestChunk(lishID: LISHid, chunkID: ChunkID): Promise<Uint8Array | null> {
		try {
			// Bail early if stream is already closed/aborted
			if (this.stream.status !== 'open') {
				throw new Error(`Stream not open: ${this.stream.status}`);
			}
			// Create the request
			const request: LISHRequest = {
				lishID,
				chunkID,
			};
			// Send the request
			const requestData = new TextEncoder().encode(JSON.stringify(request));
			sendLengthPrefixed(this.stream, requestData);
			// Read the response (with timeout — prevents hanging on dead/aborted streams)
			const responseMsg = await Promise.race([
				this.decoder.next(),
				rejectAfterTimeout(30000, 'receive'),
			]) as IteratorResult<Uint8Array | Uint8ArrayList>;
			if (responseMsg.done || !responseMsg.value) return null;
			const responseData = responseMsg.value instanceof Uint8ArrayList ? responseMsg.value.subarray() : responseMsg.value;
			const response: LISHResponse = JSON.parse(new TextDecoder().decode(responseData));
			if (response.data) {
				// Support both base64 (our branch) and number[] (main branch) formats
				if (typeof response.data === 'string') return new Uint8Array(Buffer.from(response.data, 'base64'));
				if (Array.isArray(response.data)) return new Uint8Array(response.data);
				return null;
			}
			return null;
		} catch (error) {
			console.error('Error requesting chunk:', error);
			throw error;
		}
	}

	// Close the stream when done
	async close(): Promise<void> {
		try {
			await this.stream.close();
		} catch (error) {
			// Ignore errors on close
		}
	}
}

export function setMaxUploadSpeed(kbPerSec: number): void { uploadLimiter.setLimit(kbPerSec); }

type BroadcastFn = (event: string, data: any) => void;
let broadcastFn: BroadcastFn | null = null;
// Per-LISH upload tracking
const activeUploads = new Map<string, { chunks: number; startTime: number; bytes: number; peers: number; speedSamples: { time: number; bytes: number }[] }>();
// Per-LISH active stream count
const activeStreamCount = new Map<string, number>();

export function setUploadBroadcast(fn: BroadcastFn): void { broadcastFn = fn; }
export function getActiveUploads(): Map<string, { chunks: number; startTime: number; bytes: number; peers: number; speedSamples: { time: number; bytes: number }[] }> { return activeUploads; }

/** Reset all module-level upload state. For use in tests only. */
export function resetUploadState(): void {
	activeUploads.clear();
	activeStreamCount.clear();
	uploadEnabled.clear();
	uploadLimiter.setLimit(0);
	uploadLimiter.reset();
	broadcastFn = null;
}

// Per-LISH upload enabled/paused — persisted to DB, default=paused
const uploadEnabled = new Set<string>();
let persistUploadState: ((lishID: string, enabled: boolean) => void) | null = null;

export function initUploadState(enabledLishs: Set<string>, persistFn: (lishID: string, enabled: boolean) => void): void {
	uploadEnabled.clear();
	for (const id of enabledLishs) uploadEnabled.add(id);
	persistUploadState = persistFn;
	console.log(`[Upload] ${uploadEnabled.size} LISHs enabled`);
}
export function disableUpload(lishID: string): void { uploadEnabled.delete(lishID); persistUploadState?.(lishID, false); broadcastFn?.('transfer.upload:disabled', { lishID }); }
export function enableUpload(lishID: string): void { uploadEnabled.add(lishID); persistUploadState?.(lishID, true); broadcastFn?.('transfer.upload:enabled', { lishID }); }
export function isUploadDisabled(lishID: string): boolean { return !uploadEnabled.has(lishID); }
export function isUploadEnabled(lishID: string): boolean { return uploadEnabled.has(lishID); }
export function getEnabledUploads(): Set<string> { return uploadEnabled; }
/** Remove in-memory upload state without DB persist (for LISH deletion). */
export function removeUploadState(lishID: string): void { uploadEnabled.delete(lishID); broadcastFn?.('transfer.upload:disabled', { lishID }); }

const IO_ERROR_THRESHOLD = 3; // consecutive I/O errors before auto-disabling upload

export async function handleLISHProtocol(stream: Stream, dataServer: DataServer): Promise<void> {
	const servedLishIDs = new Set<string>();
	const ioErrorCounts = new Map<string, number>(); // per-LISH consecutive I/O error counter
	try {
		// Wrap the stream with length-prefixed decoder for multiple messages
		const decoder = decode(stream);
		// Handle multiple requests on the same stream
		for await (const msg of decoder) {
			const data = msg instanceof Uint8ArrayList ? msg.subarray() : msg;
			const request: LISHRequest = JSON.parse(new TextDecoder().decode(data));

			if (request.type === 'manifest') {
				const lish = dataServer.get(request.lishID as LISHid);
				let manifest: import('@shared').IStoredLISH | null = null;
				if (lish) {
					const { directory, chunks, ...exportData } = lish;
					manifest = exportData as import('@shared').IStoredLISH;
				}
				const response: LISHManifestResponse = { manifest };
				const responseData = new TextEncoder().encode(JSON.stringify(response));
				sendLengthPrefixed(stream, responseData);
			} else {
				// Chunk request (default)
				const chunkReq = request as LISHChunkRequest;
				if (!uploadEnabled.has(chunkReq.lishID) || isBusy(chunkReq.lishID)) {
					// Send null response — peer sees 'not_available' and moves on
					const blockedResponse: LISHResponse = { data: null };
					const blockedData = new TextEncoder().encode(JSON.stringify(blockedResponse));
					sendLengthPrefixed(stream, blockedData);
					continue;
				}
				const chunkResult = await dataServer.getChunk(chunkReq.lishID, chunkReq.chunkID);
				if (chunkResult === 'io_error') {
					// Track consecutive I/O errors per LISH
					const count = (ioErrorCounts.get(chunkReq.lishID) ?? 0) + 1;
					ioErrorCounts.set(chunkReq.lishID, count);
					const nullResponse: LISHResponse = { data: null };
					sendLengthPrefixed(stream, new TextEncoder().encode(JSON.stringify(nullResponse)));
					if (count >= IO_ERROR_THRESHOLD && uploadEnabled.has(chunkReq.lishID)) {
						console.error(`[Upload] ${chunkReq.lishID.slice(0, 8)}: ${count} consecutive I/O errors — auto-disabling upload`);
						disableUpload(chunkReq.lishID);
						dataServer.setError(chunkReq.lishID as import('@shared').LISHid, 'DIRECTORY_MISSING', `Upload I/O error`);
						broadcastFn?.('transfer.upload:error', { lishID: chunkReq.lishID, error: 'DIRECTORY_MISSING', errorDetail: 'Upload source directory not accessible' });
					}
					continue;
				}
				const chunkData = chunkResult;
				const response: LISHResponse = { data: chunkData ? Buffer.from(chunkData).toString('base64') : null };
				const responseData = new TextEncoder().encode(JSON.stringify(response));
				sendLengthPrefixed(stream, responseData);
				if (chunkData) {
					ioErrorCounts.delete(chunkReq.lishID); // reset on success
					if (!servedLishIDs.has(chunkReq.lishID)) {
						servedLishIDs.add(chunkReq.lishID);
						activeStreamCount.set(chunkReq.lishID, (activeStreamCount.get(chunkReq.lishID) ?? 0) + 1);
					}
					dataServer.incrementUploadedBytes(chunkReq.lishID as import('@shared').LISHid, chunkData.length);
					await uploadLimiter.throttle(chunkData.length);
					// Upload progress tracking (rolling 10s speed window)
					if (broadcastFn) {
						let info = activeUploads.get(chunkReq.lishID);
						if (!info) { info = { chunks: 0, startTime: Date.now(), bytes: 0, peers: 0, speedSamples: [] }; activeUploads.set(chunkReq.lishID, info); }
						info.chunks++;
						info.bytes += chunkData.length;
						info.peers = activeStreamCount.get(chunkReq.lishID) ?? 1;
						const now = Date.now();
						info.speedSamples.push({ time: now, bytes: chunkData.length });
						info.speedSamples = info.speedSamples.filter(s => s.time > now - 10000);
						const windowBytes = info.speedSamples.reduce((sum, s) => sum + s.bytes, 0);
						const windowSec = info.speedSamples.length > 1 ? (now - info.speedSamples[0]!.time) / 1000 : (now - info.startTime) / 1000;
						const bytesPerSecond = windowSec > 0.1 ? Math.round(windowBytes / windowSec) : 0;
						broadcastFn('transfer.upload:progress', { lishID: chunkReq.lishID, uploadedChunks: info.chunks, bytesPerSecond, peers: info.peers });
					}
				}
			}
		}
		// Stream closed by remote, close our end
		await stream.close();
	} catch (error) {
		console.error('Error handling lish protocol:', error);
		stream.abort(error instanceof Error ? error : new Error(String(error)));
	} finally {
		// Decrement stream count per LISH; only clean up when last stream closes
		for (const lishID of servedLishIDs) {
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

// Helper: reject after timeout (prevents hanging on dead streams)
function rejectAfterTimeout(ms: number, label: string): Promise<never> {
	return new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label} took >${ms}ms`)), ms));
}

// Helper to send a length-prefixed message (single atomic send — no inter-chunk race window)
function sendLengthPrefixed(stream: Stream, data: Uint8Array): void {
	stream.send(lpEncode.single(data));
}
