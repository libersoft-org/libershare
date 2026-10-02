import { FFIType, ptr, read } from 'bun:ffi';
import { loadSystemLibrary } from '../library.ts';
import { decodeNetlinkDatagram, NetlinkError, type NetlinkMessage } from './netlink-wire.ts';

export interface NetlinkReadOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface NetlinkTransport {
	send(data: Buffer): void;
	receive(): Buffer | undefined;
	close(): void;
}

function openSocket(protocol: number): NetlinkTransport {
	if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) throw new NetlinkError('Netlink requires Linux x64 or ARM64');
	const library = loadSystemLibrary('libc.so.6', {
		socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		sendto: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i64 },
		recvfrom: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i64 },
		close: { args: [FFIType.i32], returns: FFIType.i32 },
		__errno_location: { args: [], returns: FFIType.ptr },
	});
	const libc = library.symbols;
	const errno = (): number => read.i32(libc.__errno_location()!);
	const fd = libc.socket(16, 3 | 0x80000 | 0x800, protocol);
	if (fd < 0) {
		const error = errno();
		library.close();
		throw new NetlinkError('Netlink socket failed', error);
	}
	let closed = false;
	const buffer = Buffer.alloc(256 * 1024);
	return {
		send(data) {
			const address = Buffer.alloc(12);
			address.writeUInt16LE(16);
			if (Number(libc.sendto(fd, ptr(data), BigInt(data.length), 0, ptr(address), 12)) !== data.length) throw new NetlinkError('Netlink send failed', errno());
		},
		receive() {
			const sender = Buffer.alloc(12);
			const size = Buffer.alloc(4);
			size.writeUInt32LE(12);
			// MSG_TRUNC reports the full datagram length rather than silently losing its tail.
			const length = Number(libc.recvfrom(fd, ptr(buffer), BigInt(buffer.length), 0x20 | 0x40, ptr(sender), ptr(size)));
			if (length < 0) {
				const error = errno();
				if (error === 11 || error === 4) return undefined;
				throw new NetlinkError('Netlink receive failed', error);
			}
			if (length === 0 || length > buffer.length) throw new NetlinkError('Truncated netlink datagram');
			if (size.readUInt32LE() !== 12 || sender.readUInt16LE() !== 16 || sender.readUInt32LE(4) !== 0) throw new NetlinkError('Netlink reply is not from the kernel');
			return Buffer.from(buffer.subarray(0, length));
		},
		close() {
			if (closed) return;
			closed = true;
			libc.close(fd);
			library.close();
		},
	};
}

let nextSequence = 0;

export async function requestNetlink(protocol: number, type: number, body: Buffer, dump: boolean, options: NetlinkReadOptions = {}, transportFactory: (protocol: number) => NetlinkTransport = openSocket): Promise<NetlinkMessage[]> {
	options.signal?.throwIfAborted();
	const timeout = options.timeoutMs ?? 5000;
	if (!Number.isFinite(timeout) || timeout <= 0) throw new NetlinkError('Invalid netlink timeout');
	const deadline = performance.now() + timeout;
	const sequence = (nextSequence = (nextSequence + 1) >>> 0);
	const request = Buffer.alloc(16 + body.length);
	request.writeUInt32LE(request.length);
	request.writeUInt16LE(type, 4);
	request.writeUInt16LE(1 | (dump ? 0x300 : 0), 6);
	request.writeUInt32LE(sequence, 8);
	body.copy(request, 16);
	const transport = transportFactory(protocol);
	const abort = (): void => transport.close();
	options.signal?.addEventListener('abort', abort, { once: true });
	try {
		transport.send(request);
		const messages: NetlinkMessage[] = [];
		let bytes = 0;
		while (true) {
			options.signal?.throwIfAborted();
			if (performance.now() >= deadline) throw new NetlinkError('Netlink read timed out');
			const data = transport.receive();
			if (!data) {
				await new Promise(resolve => setTimeout(resolve, 5));
				continue;
			}
			bytes += data.length;
			if (bytes > 8 * 1024 * 1024) throw new NetlinkError('Netlink reply exceeds size limit');
			const reply = decodeNetlinkDatagram(data, sequence);
			messages.push(...reply.messages);
			if (messages.length > 65536) throw new NetlinkError('Netlink reply exceeds message limit');
			if (reply.done || (!dump && reply.messages.some(message => !(message.flags & 2)))) return messages;
		}
	} finally {
		options.signal?.removeEventListener('abort', abort);
		transport.close();
	}
}
