import type { Uint8ArrayList } from 'uint8arraylist';

/** The stream ended inside a frame or inside its length prefix. */
export class FrameEndedError extends Error {
	override name = 'FrameEndedError';
}

// A varint of Number.MAX_SAFE_INTEGER; the same bound it-length-prefixed uses on the sending side.
const MAX_PREFIX_BYTES = 8;

/**
 * Reads varint-length-prefixed frames off a byte stream, each into one buffer allocated at its
 * announced length. Incoming pieces are copied in as they arrive and dropped at once, so a frame
 * costs its own size while it is received and nothing once it is handed over.
 *
 * Not `it-length-prefixed`'s decoder: that one collects the pieces of a frame in a list, the caller
 * then copies the list into one array, and its suspended generator keeps the list until the next
 * read. A large frame is then held twice for as long as the caller works on it, which for a chunk
 * reply means twice the bytes the in-flight budget counts.
 */
export class FrameReader {
	private readonly source: AsyncIterator<Uint8Array | Uint8ArrayList>;
	/** Unread parts of the pieces already taken from the source, and the read position in the first. */
	private parts: Uint8Array[] = [];
	private offset = 0;

	constructor(source: AsyncIterable<Uint8Array | Uint8ArrayList>) {
		this.source = source[Symbol.asyncIterator]();
	}

	/**
	 * The next frame, or undefined when the stream ended between frames. `onLength` gets the
	 * announced length before anything is allocated or read for the body; throwing from it refuses
	 * the frame. Throws {@link FrameEndedError} when the stream ends inside a frame.
	 */
	async next(onLength: (length: number) => void): Promise<Uint8Array | undefined> {
		let length = 0;
		for (let prefixBytes = 0; ;) {
			const part = await this.part();
			if (!part) {
				if (prefixBytes === 0) return undefined;
				throw new FrameEndedError('stream ended inside a length prefix');
			}
			const byte = part[this.offset++]!;
			// Multiplied, not shifted: a length may need more than 32 bits before it is refused.
			length += (byte & 0x7f) * 2 ** (7 * prefixBytes++);
			if (byte < 0x80) break;
			if (prefixBytes === MAX_PREFIX_BYTES) throw new Error('frame length prefix too long');
		}
		onLength(length);
		const frame = new Uint8Array(length);
		for (let filled = 0; filled < length;) {
			const part = await this.part();
			if (!part) throw new FrameEndedError(`stream ended ${length - filled} bytes short of a frame`);
			const take = Math.min(length - filled, part.length - this.offset);
			frame.set(part.subarray(this.offset, this.offset + take), filled);
			filled += take;
			this.offset += take;
		}
		return frame;
	}

	/** The part being read, with at least one unread byte left; undefined at the end of the stream. */
	private async part(): Promise<Uint8Array | undefined> {
		for (;;) {
			const current = this.parts[0];
			if (current && this.offset < current.length) return current;
			this.offset = 0;
			if (current) {
				this.parts.shift();
				continue;
			}
			const piece = await this.source.next();
			if (piece.done) return undefined;
			// A list is iterable over its arrays, whichever copy of the package built it.
			this.parts = piece.value instanceof Uint8Array ? [piece.value] : [...piece.value];
		}
	}
}
