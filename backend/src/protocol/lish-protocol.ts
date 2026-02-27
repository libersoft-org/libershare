import { decode } from 'it-length-prefixed';
import { encode as lpEncode } from 'it-length-prefixed';
import { type Stream } from '@libp2p/interface';
import { type LISHid, type ChunkID } from '../lish/lish.ts';
import { type DataServer } from '../lish/data-server.ts';
import { Uint8ArrayList } from 'uint8arraylist';
export const LISH_PROTOCOL = '/lish/1.0.0';
export interface LISHRequest {
	lishID: LISHid;
	chunkID: ChunkID;
}
export interface LISHResponse {
	data: number[] | null;
}
export type HaveChunks = 'all' | ChunkID[];

// Client-side stream wrapper that can send multiple requests
export class LISHClient {
	private stream: Stream;
	private decoder: AsyncGenerator<Uint8Array | Uint8ArrayList>;
	// TODO: is haveChunks still used? review whether this belongs here
	public haveChunks: HaveChunks;
	constructor(stream: Stream) {
		this.stream = stream;
		this.decoder = decode(stream);
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

export async function handleLISHProtocol(stream: Stream, dataServer: DataServer): Promise<void> {
	try {
		// Wrap the stream with length-prefixed decoder for multiple messages
		const decoder = decode(stream);
		// Handle multiple requests on the same stream
		for await (const msg of decoder) {
			// Convert to Uint8Array if needed
			const data = msg instanceof Uint8ArrayList ? msg.subarray() : msg;
			const request: LISHRequest = JSON.parse(new TextDecoder().decode(data));
			console.log(`Received lish request: ${request.lishID.slice(0, 8)}... chunk ${request.chunkID.slice(0, 8)}...`);
			// Get the chunk
			const chunkData = await dataServer.getChunk(request.lishID, request.chunkID);
			// Write the response
			const response: LISHResponse = {
				data: chunkData ? Array.from(chunkData) : null,
			};
			const responseData = new TextEncoder().encode(JSON.stringify(response));
			// Send response with length prefix
			await sendLengthPrefixed(stream, responseData);
			console.log(`Responded with ${chunkData ? chunkData.length : 0} bytes`);
		}
		// Stream closed by remote, close our end
		await stream.close();
	} catch (error) {
		console.error('Error handling lish protocol:', error);
		stream.abort(error instanceof Error ? error : new Error(String(error)));
	}
}

// Helper to send a length-prefixed message
async function sendLengthPrefixed(stream: Stream, data: Uint8Array): Promise<void> {
	// Encode the message with length prefix - returns AsyncGenerator<Uint8Array>
	const encoded = lpEncode([data]);
	// Send all chunks from the encoder
	for await (const chunk of encoded) {
		stream.send(chunk);
	}
}
