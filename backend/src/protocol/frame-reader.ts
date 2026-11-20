import type { Uint8ArrayList } from 'uint8arraylist';

/** The stream ended inside a frame or inside its length prefix. */
export class FrameEndedError extends Error {
	override name = 'FrameEndedError';
}

// A varint of Number.MAX_SAFE_INTEGER; the same bound it-length-prefixed uses on the sending side.
const MAX_PREFIX_BYTES = 8;

// Taken at once on top of what the caller made room for; past it the buffer doubles as the bytes
// arrive. Covers the envelope around a chunk, so a chunk reply still gets its buffer in one piece.
const FIRST_BUFFER_BYTES = 64 * 1024;

/**
 * Reads varint-length-prefixed frames off a byte stream. A frame that spans several incoming
 * pieces is assembled in one buffer: the pieces are copied in as they arrive and dropped at once,
 * so the frame costs its own size while it is received and nothing once it is handed over. The
 * buffer starts at what the caller has made room for, plus a little, and grows past that with the
 * bytes that arrive, so a peer that announces a large frame and sends little of it costs little.
 * A frame that arrives whole inside one piece is handed out as a view of that piece, without a
 * copy.
 *
 * Not `it-length-prefixed`'s decoder: that one collects the pieces of a frame in a list, the caller
 * then copies the list into one array, and its suspended generator keeps the list until the next
 * read. A large frame is then held twice for as long as the caller works on it, which for a chunk
 * reply means twice the bytes the in-flight budget counts.
 *
 * Like that decoder's generator, the reader serves one read at a time and is finished for good
 * once a read fails: the bytes left over belong to a broken reply and are not a frame.
 */
export class FrameReader {
	private readonly source: AsyncIterator<Uint8Array | Uint8ArrayList>;
	/** Unread parts of the pieces already taken from the source, and the read position in the first. */
	private parts: Uint8Array[] = [];
	private offset = 0;
	/** Set when the stream ended or a read failed; nothing is read after that. */
	private ended = false;
	/** Settles with the read in progress, so reads run one at a time in the order they were asked for. */
	private tail: Promise<unknown> = Promise.resolve();

	constructor(source: AsyncIterable<Uint8Array | Uint8ArrayList>) {
		this.source = source[Symbol.asyncIterator]();
	}

	/**
	 * The next frame, or undefined when the stream ended between frames or an earlier read failed.
	 * `onLength` gets the announced length before anything is allocated or read for the body;
	 * throwing from it refuses the frame. `roomMade` is how many bytes the caller has already set
	 * memory aside for; that much of the buffer is taken at once. Throws {@link FrameEndedError}
	 * when the stream ends inside a frame.
	 */
	next(onLength: (length: number) => void, roomMade = 0): Promise<Uint8Array | undefined> {
		const frame = this.tail.then(() => this.read(onLength, roomMade));
		// Only that the read is over, never its result: a promise kept here would keep the frame alive.
		this.tail = frame.then(
			() => {},
			() => {}
		);
		return frame;
	}

	private async read(onLength: (length: number) => void, roomMade: number): Promise<Uint8Array | undefined> {
		if (this.ended) return undefined;
		try {
			let length = 0;
			for (let prefixBytes = 0; ;) {
				const part = await this.part();
				if (!part) {
					if (prefixBytes > 0) throw new FrameEndedError('stream ended inside a length prefix');
					this.end();
					return undefined;
				}
				const byte = part[this.offset++]!;
				// Multiplied, not shifted: a length may need more than 32 bits before it is refused.
				length += (byte & 0x7f) * 2 ** (7 * prefixBytes++);
				if (byte < 0x80) break;
				if (prefixBytes === MAX_PREFIX_BYTES) throw new Error('frame length prefix too long');
			}
			onLength(length);
			const first = length > 0 ? await this.part() : undefined;
			let frame: Uint8Array;
			if (first && first.length - this.offset >= length) {
				frame = first.subarray(this.offset, this.offset + length);
				this.offset += length;
			} else {
				frame = new Uint8Array(Math.min(length, roomMade + FIRST_BUFFER_BYTES));
				for (let filled = 0; filled < length;) {
					const part = await this.part();
					if (!part) throw new FrameEndedError(`stream ended ${length - filled} bytes short of a frame`);
					const take = Math.min(length - filled, part.length - this.offset);
					if (filled + take > frame.length) {
						const grown = new Uint8Array(Math.min(length, Math.max(frame.length * 2, filled + take)));
						grown.set(frame.subarray(0, filled));
						frame = grown;
					}
					frame.set(part.subarray(this.offset, this.offset + take), filled);
					filled += take;
					this.offset += take;
				}
			}
			// A piece read to its end is let go now, not at the next read, which may be far away.
			if (this.parts[0] && this.offset >= this.parts[0].length) {
				this.parts.shift();
				this.offset = 0;
			}
			return frame;
		} catch (error) {
			this.end();
			throw error;
		}
	}

	private end(): void {
		this.ended = true;
		this.parts = [];
		this.offset = 0;
		// Nothing more will be pulled: let the source clean up, as leaving a `for await` early would.
		void Promise.resolve(this.source.return?.()).catch(() => {});
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
