import { MAX_API_MESSAGE_SIZE } from './product.ts';

export const IPC_VERSION: number = 1;
export const IPC_HEADER_SIZE: number = 5;
export const IPC_MAX_PAYLOAD_SIZE: number = MAX_API_MESSAGE_SIZE;
export const IPC_KIND: Readonly<{ Ready: 1; Open: 2; Opened: 3; Text: 4; Binary: 5; Close: 6 }> = {
	Ready: 1,
	Open: 2,
	Opened: 3,
	Text: 4,
	Binary: 5,
	Close: 6,
};
export type IpcKind = (typeof IPC_KIND)[keyof typeof IPC_KIND];

export interface IpcFrame {
	kind: IpcKind;
	session: number;
	payload: Uint8Array;
}

function isKind(kind: number): kind is IpcKind {
	return Number.isInteger(kind) && kind >= IPC_KIND.Ready && kind <= IPC_KIND.Close;
}

function validateBodySize(size: number): void {
	if (size < IPC_HEADER_SIZE || size > IPC_HEADER_SIZE + IPC_MAX_PAYLOAD_SIZE) throw new RangeError('Invalid IPC frame length');
}

function validateEnvelope(kind: IpcKind, session: number, payload: Uint8Array): void {
	if (!isKind(kind)) throw new Error('Unknown IPC frame kind');
	if (!Number.isInteger(session) || session < 0 || session > 0xffffffff) throw new RangeError('Invalid IPC session');
	validateBodySize(IPC_HEADER_SIZE + payload.byteLength);
}

function writeBody(body: Uint8Array, kind: IpcKind, session: number, payload: Uint8Array): void {
	body[0] = kind;
	new DataView(body.buffer, body.byteOffset, body.byteLength).setUint32(1, session);
	body.set(payload, IPC_HEADER_SIZE);
}

/** The raw Tauri invoke body omits the pipe's four-byte length prefix. */
export function encodeIpcBody(kind: IpcKind, session: number, payload: Uint8Array = new Uint8Array()): Uint8Array {
	validateEnvelope(kind, session, payload);
	const body = new Uint8Array(IPC_HEADER_SIZE + payload.byteLength);
	writeBody(body, kind, session, payload);
	return body;
}

export function encodeIpcFrame(kind: IpcKind, session: number, payload: Uint8Array = new Uint8Array()): Uint8Array {
	validateEnvelope(kind, session, payload);
	const frame = new Uint8Array(4 + IPC_HEADER_SIZE + payload.byteLength);
	new DataView(frame.buffer).setUint32(0, frame.byteLength - 4);
	writeBody(frame.subarray(4), kind, session, payload);
	return frame;
}

export function decodeIpcBody(body: Uint8Array): IpcFrame {
	validateBodySize(body.byteLength);
	const kind = body[0]!;
	if (!isKind(kind)) throw new Error('Unknown IPC frame kind');
	return {
		kind,
		session: new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(1),
		payload: body.subarray(IPC_HEADER_SIZE),
	};
}

/** Lengths are checked before allocation; partial reads never change frame boundaries. */
export class IpcFrameDecoder {
	private readonly prefix = new Uint8Array(4);
	private prefixBytes = 0;
	private body: Uint8Array | null = null;
	private bodyBytes = 0;

	push(chunk: Uint8Array): IpcFrame[] {
		const frames: IpcFrame[] = [];
		let offset = 0;
		while (offset < chunk.byteLength) {
			if (this.body === null) {
				const count = Math.min(4 - this.prefixBytes, chunk.byteLength - offset);
				this.prefix.set(chunk.subarray(offset, offset + count), this.prefixBytes);
				this.prefixBytes += count;
				offset += count;
				if (this.prefixBytes !== 4) continue;
				const size = new DataView(this.prefix.buffer).getUint32(0);
				validateBodySize(size);
				this.body = new Uint8Array(size);
				this.bodyBytes = 0;
			}
			const count = Math.min(this.body.byteLength - this.bodyBytes, chunk.byteLength - offset);
			this.body.set(chunk.subarray(offset, offset + count), this.bodyBytes);
			this.bodyBytes += count;
			offset += count;
			if (this.bodyBytes === this.body.byteLength) {
				frames.push(decodeIpcBody(this.body));
				this.body = null;
				this.bodyBytes = 0;
				this.prefixBytes = 0;
			}
		}
		return frames;
	}

	finish(): void {
		if (this.prefixBytes !== 0 || this.body !== null) throw new Error('Truncated IPC frame');
	}
}
