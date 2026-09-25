// Wire codec for the LISH p2p protocol.
// Single place where a concrete encoding library is referenced — switching formats
// (e.g. msgpack → cbor → bson) only requires touching this file. All protocol call
// sites use `encode()` / `decode()` and stay agnostic.
//
// Current backend: msgpackr (MessagePack). Chosen because:
//   - Native binary type → no base64 overhead for chunk payloads.
//   - One library for all requests/responses (requests, manifests, chunks, lists).
//   - Comparable or faster than native JSON.parse on mixed payloads.
//   - Stable, widely used, no schema required.
import { Packr, Unpackr } from 'msgpackr';
import { checkMessageShape, WIRE_MESSAGE_BUDGET } from './message-budget.ts';

// Shared encoder/decoder instances — msgpackr reuses internal buffers for performance.
// `useRecords: false` keeps the format fully schema-less so peers on different versions
// still interoperate as long as they agree on JSON-compatible shapes.
const packr = new Packr({ useRecords: false });
const unpackr = new Unpackr({ useRecords: false });

/** Encode an arbitrary JSON-like value (including Uint8Array fields) to wire bytes. */
export function encode(value: unknown): Uint8Array {
	return packr.pack(value);
}

/**
 * Decode wire bytes produced by `encode` back into a JS value. Throws on malformed input and on
 * a message outside {@link WIRE_MESSAGE_BUDGET}, checked before any value is built.
 */
export function decode<T = unknown>(data: Uint8Array): T {
	checkMessageShape(data, WIRE_MESSAGE_BUDGET);
	return unpackr.unpack(data) as T;
}
