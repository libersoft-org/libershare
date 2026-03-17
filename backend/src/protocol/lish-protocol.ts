import { decode } from 'it-length-prefixed';
import { encode as lpEncode } from 'it-length-prefixed';
import { type Stream } from '@libp2p/interface';
import { type LISHid, type ChunkID } from '@shared';
import { type DataServer } from '../lish/data-server.ts';
import { Uint8ArrayList } from 'uint8arraylist';
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
	data: number[] | null;
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
			await sendLengthPrefixed(this.stream, requestData);
			const responseMsg = await this.decoder.next();
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
			console.log(`[Client] Stream status before request: read=${this.stream.status}, write=${this.stream.writeStatus}`);
			// Create the request
			const request: LISHRequest = {
				lishID,
				chunkID,
			};
			// Send the request
			const requestData = new TextEncoder().encode(JSON.stringify(request));
			await sendLengthPrefixed(this.stream, requestData);
			console.log(`[Client] Stream status after send: read=${this.stream.status}, write=${this.stream.writeStatus}`);
			// Read the response
			const responseMsg = await this.decoder.next();
			console.log(`[Client] Stream status after receive: read=${this.stream.status}, write=${this.stream.writeStatus}`);
			if (responseMsg.done) {
				console.log('Stream closed before receiving response');
				return null;
			}
			// Convert to Uint8Array if needed
			if (!responseMsg.value) {
				console.log('Response has no data');
				return null;
			}
			const responseData = responseMsg.value instanceof Uint8ArrayList ? responseMsg.value.subarray() : responseMsg.value;
			const response: LISHResponse = JSON.parse(new TextDecoder().decode(responseData));
			// Convert number array back to Uint8Array
			if (response.data) return new Uint8Array(response.data);
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

let uploadMaxBytesPerSec = 0;
let uploadStartTime = 0;
let uploadedBytes = 0;

export function setMaxUploadSpeed(kbPerSec: number): void { uploadMaxBytesPerSec = Math.max(0, kbPerSec) * 1024; }

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
	uploadMaxBytesPerSec = 0;
	uploadStartTime = 0;
	uploadedBytes = 0;
	broadcastFn = null;
}

// Per-LISH upload enabled/paused — persisted to DB, default=paused
const uploadEnabled = new Set<string>();
let persistUploadState: ((lishID: string, enabled: boolean) => void) | null = null;

export function initUploadState(enabledLishs: Set<string>, persistFn: (lishID: string, enabled: boolean) => void): void {
	uploadEnabled.clear();
	for (const id of enabledLishs) uploadEnabled.add(id);
	persistUploadState = persistFn;
}
export function pauseUpload(lishID: string): void { uploadEnabled.delete(lishID); persistUploadState?.(lishID, false); broadcastFn?.('transfer.upload:paused', { lishID }); }
export function resumeUpload(lishID: string): void { uploadEnabled.add(lishID); persistUploadState?.(lishID, true); broadcastFn?.('transfer.upload:resumed', { lishID }); }
export function isUploadPaused(lishID: string): boolean { return !uploadEnabled.has(lishID); }
export function isUploadEnabled(lishID: string): boolean { return uploadEnabled.has(lishID); }
export function getEnabledUploads(): Set<string> { return uploadEnabled; }

export async function handleLISHProtocol(stream: Stream, dataServer: DataServer): Promise<void> {
	const servedLishIDs = new Set<string>();
	try {
		// Wrap the stream with length-prefixed decoder for multiple messages
		const decoder = decode(stream);
		// Handle multiple requests on the same stream
		for await (const msg of decoder) {
			const data = msg instanceof Uint8ArrayList ? msg.subarray() : msg;
			const request: LISHRequest = JSON.parse(new TextDecoder().decode(data));

			if (request.type === 'manifest') {
				// Manifest request — return full LISH data (without directory path and chunks)
				console.log(`Received manifest request for ${request.lishID.slice(0, 8)}...`);
				const lish = dataServer.get(request.lishID as LISHid);
				let manifest: import('@shared').IStoredLISH | null = null;
				if (lish) {
					const { directory, chunks, ...exportData } = lish;
					manifest = exportData as import('@shared').IStoredLISH;
				}
				const response: LISHManifestResponse = { manifest };
				const responseData = new TextEncoder().encode(JSON.stringify(response));
				await sendLengthPrefixed(stream, responseData);
				console.log(`Responded with manifest: ${manifest ? 'found' : 'not found'}`);
			} else {
				// Chunk request (default)
				const chunkReq = request as LISHChunkRequest;
				// Refuse to serve if upload is paused — close the stream so peer disconnects immediately
				if (!uploadEnabled.has(chunkReq.lishID)) {
					console.log(`Upload paused for ${chunkReq.lishID.slice(0, 8)}, closing stream`);
					stream.abort(new Error('UPLOAD_PAUSED'));
					return;
				}
				const chunkData = await dataServer.getChunk(chunkReq.lishID, chunkReq.chunkID);
				const response: LISHResponse = { data: chunkData ? Array.from(chunkData) : null };
				const responseData = new TextEncoder().encode(JSON.stringify(response));
				await sendLengthPrefixed(stream, responseData);
				if (chunkData) {
					if (!servedLishIDs.has(chunkReq.lishID)) {
						servedLishIDs.add(chunkReq.lishID);
						activeStreamCount.set(chunkReq.lishID, (activeStreamCount.get(chunkReq.lishID) ?? 0) + 1);
					}
					// Upload speed limit
					if (uploadMaxBytesPerSec > 0) {
						if (uploadStartTime === 0) uploadStartTime = Date.now();
						uploadedBytes += chunkData.length;
						const elapsed = (Date.now() - uploadStartTime) / 1000;
						const expectedTime = uploadedBytes / uploadMaxBytesPerSec;
						const waitMs = Math.max(0, (expectedTime - elapsed) * 1000);
						if (waitMs > 10) await new Promise(r => setTimeout(r, waitMs));
					}
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

// Helper to send a length-prefixed message
async function sendLengthPrefixed(stream: Stream, data: Uint8Array): Promise<void> {
	// Encode the message with length prefix - returns AsyncGenerator<Uint8Array>
	const encoded = lpEncode([data]);
	// Send all chunks from the encoder
	for await (const chunk of encoded) stream.send(chunk);
}
