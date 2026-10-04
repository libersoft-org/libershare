/** Limits a MessagePack message must stay within before it is turned into objects. */
export interface MessageBudget {
	/** Most values (scalars, containers, map keys) in the whole message. */
	readonly maxTokens: number;
	/** Deepest nesting of arrays and maps. */
	readonly maxDepth: number;
}

/**
 * Budget for every message read off the wire. The largest honest message is a manifest or a
 * HAVE snapshot: a few values per chunk, so two million values leave room for 500 000 chunks
 * while a flood of one-byte empty objects cannot turn a frame into gigabytes of heap. Honest
 * messages nest four levels deep at most.
 */
export const WIRE_MESSAGE_BUDGET: MessageBudget = { maxTokens: 2_000_000, maxDepth: 16 };

/** Extension types the encoder really emits: 0 for `undefined`, -1 (0xff) for a Date. */
const ALLOWED_EXT_TYPES = new Set([0x00, 0xff]);

/**
 * Walk the MessagePack tokens of `data` without building any value and throw when the message
 * is not exactly one well-formed value inside `budget`: too many values, nesting too deep, a
 * container declaring more children than bytes remain, a length past the end, an extension
 * type the encoder never produces, the reserved 0xc1 byte, or bytes after the value.
 * Iterative, so a deeply nested input cannot exhaust the call stack.
 */
export function checkMessageShape(data: Uint8Array, budget: MessageBudget = WIRE_MESSAGE_BUDGET): void {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const end = data.byteLength;
	// Values still expected by each open container, innermost last.
	const pending: number[] = [];
	let pos = 0;
	let tokens = 0;
	let done = false;
	const need = (bytes: number): void => {
		if (bytes > end - pos) throw new Error('message is truncated');
	};
	const uint = (bytes: 1 | 2 | 4): number => {
		need(bytes);
		const value = bytes === 1 ? view.getUint8(pos) : bytes === 2 ? view.getUint16(pos) : view.getUint32(pos);
		pos += bytes;
		return value;
	};
	const skip = (bytes: number): void => {
		need(bytes);
		pos += bytes;
	};
	const open = (children: number): void => {
		// Every child takes at least one byte, so a count past the remaining bytes is a lie.
		if (children > end - pos) throw new Error('container declares more values than the message holds');
		if (children > 0) {
			if (pending.length >= budget.maxDepth) throw new Error('message nests too deep');
			pending.push(children);
		}
	};
	const ext = (length: number): void => {
		need(1);
		if (!ALLOWED_EXT_TYPES.has(view.getUint8(pos))) throw new Error('unsupported extension type');
		skip(1 + length);
	};
	while (!done) {
		if (++tokens > budget.maxTokens) throw new Error('message holds too many values');
		need(1);
		const byte = view.getUint8(pos++);
		const before = pending.length;
		if (byte <= 0x7f || byte >= 0xe0 || byte === 0xc0 || byte === 0xc2 || byte === 0xc3) {
			// fixint, nil, bool
		} else if (byte <= 0x8f) open((byte & 0x0f) * 2);
		else if (byte <= 0x9f) open(byte & 0x0f);
		else if (byte <= 0xbf) skip(byte & 0x1f);
		else if (byte === 0xc4) skip(uint(1));
		else if (byte === 0xc5) skip(uint(2));
		else if (byte === 0xc6) skip(uint(4));
		else if (byte === 0xc7) ext(uint(1));
		else if (byte === 0xc8) ext(uint(2));
		else if (byte === 0xc9) ext(uint(4));
		else if (byte === 0xca) skip(4);
		else if (byte === 0xcb) skip(8);
		else if (byte >= 0xcc && byte <= 0xd3) skip(1 << (byte & 0x03));
		else if (byte >= 0xd4 && byte <= 0xd8) ext(1 << (byte - 0xd4));
		else if (byte === 0xd9) skip(uint(1));
		else if (byte === 0xda) skip(uint(2));
		else if (byte === 0xdb) skip(uint(4));
		else if (byte === 0xdc) open(uint(2));
		else if (byte === 0xdd) open(uint(4));
		else if (byte === 0xde) open(uint(2) * 2);
		else if (byte === 0xdf) open(uint(4) * 2);
		else throw new Error('reserved MessagePack byte');
		// A value that opened a container counts once its children are read.
		if (pending.length > before) continue;
		while (pending.length > 0 && --pending[pending.length - 1]! === 0) pending.pop();
		done = pending.length === 0;
	}
	if (pos !== end) throw new Error('bytes after the message');
}
