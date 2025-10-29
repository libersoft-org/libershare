import { decode } from 'it-length-prefixed';
import { encode as lpEncode } from 'it-length-prefixed';
import type { Stream } from '@libp2p/interface';
import type { LishId, ChunkId } from './lish.ts';
import type { DataServer } from './data-server.ts';
import { Uint8ArrayList } from 'uint8arraylist';

export const LISH_PROTOCOL = '/lish/1.0.0';

export interface LishRequest {
	lishId: LishId;
	chunkId: ChunkId;
}

export interface LishResponse {
	data: number[] | null;
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

export async function handleLishProtocol(stream: Stream, dataServer: DataServer): Promise<void> {
	try {
		// Wrap the stream with length-prefixed decoder for multiple messages
		const decoder = decode(stream);

		// Handle multiple requests on the same stream
		for await (const msg of decoder) {
			// Convert to Uint8Array if needed
			const data = msg instanceof Uint8ArrayList ? msg.subarray() : msg;
			const request: LishRequest = JSON.parse(new TextDecoder().decode(data));

			console.log(`Received lish request: ${request.lishId.slice(0, 8)}... chunk ${request.chunkId.slice(0, 8)}...`);

			// Get the chunk
			const chunkData = await dataServer.getChunk(request.lishId, request.chunkId);

			// Write the response
			const response: LishResponse = {
				data: chunkData ? Array.from(chunkData) : null
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
