/**
 * libp2p transport of a protected (overlay) lishnet node: TCP inside the network's Nebula overlay, reached
 * through the loopback bridge of its `lish-overlay` helper. The node has no other transport, so it can neither
 * dial nor be dialled outside the overlay.
 *
 * Bridge protocol (see overlay/run.go): every loopback connection starts with one header line carrying the
 * helper's token. Outbound: `<token> <overlay ip>:<port>\n`, answered `OK\n` or `ERR <reason>\n`. Inbound, from
 * the helper: `<token> <remote overlay ip>:<port>\n`, which becomes the connection's remote address — without
 * it every inbound connection would come from 127.0.0.1 and hit libp2p's per-address limits as one host.
 */
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { AbortError, serviceCapabilities, transportSymbol, TypedEventEmitter, type AbortOptions, type ComponentLogger, type CreateListenerOptions, type DialTransportOptions, type Listener, type ListenerEvents, type Logger, type Transport, type Upgrader, type Connection } from '@libp2p/interface';
import { AbstractMultiaddrConnection, type AbstractMultiaddrConnectionInit } from '@libp2p/utils';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { type Uint8ArrayList } from 'uint8arraylist';
import { ipInCIDR } from './address-filter.ts';

/** How long either end waits for the header line or the dial answer. The helper itself gives up a dial after 20 s. */
const HEADER_TIMEOUT_MS = 25_000;
const MAX_HEADER_BYTES = 256;

/** The helper side of the bridge, as the transport needs it. */
export interface OverlayBridge {
	/** Loopback port the helper accepts outbound connections on. */
	readonly dialPort: number;
	readonly token: string;
	/** The overlay subnet, e.g. 100.64.0.0/16: the only addresses this transport handles. */
	readonly subnet: string;
	/** Tell the helper where to hand connections arriving from the overlay (0 refuses them). */
	setInboundPort(port: number): Promise<void>;
	/**
	 * Offered every inbound connection before libp2p sees it; returns true when it took the (paused) socket over.
	 * An invite's guest is served this way: it is no member, so it never reaches the node.
	 */
	serveInbound?(socket: net.Socket, remoteIP: string): Promise<boolean>;
}

/** `/ip4/<ip>/tcp/<port>` inside the subnet, and nothing else. */
export function overlayTarget(ma: Multiaddr, subnet: string): { ip: string; port: number } | null {
	const parts = ma.getComponents();
	if (parts.length < 2 || parts[0]?.name !== 'ip4' || parts[1]?.name !== 'tcp') return null;
	if (parts.slice(2).some(p => p.name !== 'p2p')) return null;
	const ip = parts[0].value ?? '';
	const port = Number(parts[1].value);
	if (!Number.isInteger(port) || port <= 0 || port > 65535 || !ipInCIDR(ip, subnet)) return null;
	return { ip, port };
}

/**
 * Read one `\n`-terminated line from a fresh socket and push back whatever followed it, so the stream after the
 * header reaches its consumer intact.
 */
function readLine(socket: net.Socket, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		let buffered = Buffer.alloc(0);
		const cleanup = (): void => {
			clearTimeout(timer);
			socket.off('data', onData);
			socket.off('error', onError);
			socket.off('close', onClose);
			signal?.removeEventListener('abort', onAbort);
		};
		const fail = (err: Error): void => {
			cleanup();
			reject(err);
		};
		const onData = (chunk: Buffer): void => {
			buffered = Buffer.concat([buffered, chunk]);
			const nl = buffered.indexOf(0x0a);
			if (nl < 0) {
				if (buffered.length > MAX_HEADER_BYTES) fail(new Error('overlay bridge header too long'));
				return;
			}
			cleanup();
			socket.pause();
			const rest = buffered.subarray(nl + 1);
			if (rest.length > 0) socket.unshift(rest);
			resolve(buffered.subarray(0, nl).toString('utf8'));
		};
		const onError = (err: Error): void => fail(err);
		const onClose = (): void => fail(new Error('overlay bridge closed the connection'));
		const onAbort = (): void => fail(new AbortError());
		const timer = setTimeout(() => fail(new Error('overlay bridge did not answer in time')), HEADER_TIMEOUT_MS);
		socket.on('data', onData);
		socket.on('error', onError);
		socket.on('close', onClose);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

function sameToken(a: string, b: string): boolean {
	const x = Buffer.from(a, 'utf8');
	const y = Buffer.from(b, 'utf8');
	return x.length === y.length && timingSafeEqual(x, y);
}

/** A bridged loopback socket as a libp2p connection. Mirrors @libp2p/tcp's socket wrapper. */
class OverlayConnection extends AbstractMultiaddrConnection {
	private readonly socket: net.Socket;

	constructor(init: AbstractMultiaddrConnectionInit & { socket: net.Socket }) {
		super(init);
		this.socket = init.socket;
		this.socket.on('data', (buf: Buffer) => this.onData(buf));
		this.socket.on('error', err => this.abort(err));
		this.socket.once('end', () => this.onTransportClosed());
		this.socket.once('close', hadError => {
			if (hadError) this.abort(new Error('overlay bridge transmission error'));
			else this.onTransportClosed();
		});
		this.socket.on('drain', () => this.safeDispatchEvent('drain'));
		// readLine() paused the socket to keep the bytes after the header; flow starts now that they have a reader.
		this.socket.resume();
	}

	sendData(data: Uint8ArrayList): { sentBytes: number; canSendMore: boolean } {
		let sentBytes = 0;
		let canSendMore = true;
		for (const buf of data) {
			sentBytes += buf.byteLength;
			canSendMore = this.socket.write(buf);
			if (!canSendMore) break;
		}
		return { sentBytes, canSendMore };
	}

	async sendClose(options?: AbortOptions): Promise<void> {
		if (this.socket.destroyed) return;
		const closed = new Promise<void>((resolve, reject) => {
			const onAbort = (): void => reject(new AbortError());
			options?.signal?.addEventListener('abort', onAbort, { once: true });
			this.socket.once('close', () => {
				options?.signal?.removeEventListener('abort', onAbort);
				resolve();
			});
		});
		this.socket.destroySoon();
		await closed;
	}

	sendReset(): void {
		this.socket.destroy();
	}

	sendPause(): void {
		this.socket.pause();
	}

	sendResume(): void {
		this.socket.resume();
	}
}

interface OverlayTransportComponents {
	logger: ComponentLogger;
}

class OverlayListener extends TypedEventEmitter<ListenerEvents> implements Listener {
	private readonly server: net.Server;
	private readonly sockets = new Set<net.Socket>();
	private readonly shutdown = new AbortController();
	private addr: Multiaddr | null = null;
	private readonly bridge: OverlayBridge;
	private readonly upgrader: Upgrader;
	private readonly log: Logger;

	constructor(bridge: OverlayBridge, upgrader: Upgrader, log: Logger) {
		super();
		this.bridge = bridge;
		this.upgrader = upgrader;
		this.log = log;
		this.server = net.createServer(socket => void this.onSocket(socket));
		this.server.on('error', err => this.safeDispatchEvent('error', { detail: err }));
	}

	private async onSocket(socket: net.Socket): Promise<void> {
		this.sockets.add(socket);
		socket.once('close', () => this.sockets.delete(socket));
		socket.setNoDelay(true);
		let remoteAddr: Multiaddr;
		try {
			const line = await readLine(socket, this.shutdown.signal);
			const [token, remote] = line.split(' ');
			if (!token || !remote || !sameToken(token, this.bridge.token)) throw new Error('bad token');
			const sep = remote.lastIndexOf(':');
			remoteAddr = multiaddr(`/ip4/${remote.slice(0, sep)}/tcp/${remote.slice(sep + 1)}`);
			if (!overlayTarget(remoteAddr, this.bridge.subnet)) throw new Error(`remote ${remote} is outside the overlay`);
			if (this.bridge.serveInbound && (await this.bridge.serveInbound(socket, remote.slice(0, sep)))) return;
		} catch (err: any) {
			this.log('refused bridged connection - %s', err?.message ?? err);
			socket.destroy();
			return;
		}
		const maConn = new OverlayConnection({ socket, remoteAddr, direction: 'inbound', ...(this.addr ? { localAddr: this.addr } : {}), log: this.log.newScope('connection') });
		try {
			await this.upgrader.upgradeInbound(maConn, { signal: this.shutdown.signal });
		} catch (err: any) {
			this.log.error('inbound overlay connection upgrade failed - %e', err);
			maConn.abort(err);
		}
	}

	async listen(ma: Multiaddr): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.server.once('error', reject);
			this.server.listen(0, '127.0.0.1', () => {
				this.server.off('error', reject);
				resolve();
			});
		});
		const port = (this.server.address() as net.AddressInfo).port;
		await this.bridge.setInboundPort(port);
		this.addr = ma;
		this.safeDispatchEvent('listening');
	}

	getAddrs(): Multiaddr[] {
		return this.addr ? [this.addr] : [];
	}

	updateAnnounceAddrs(): void {}

	async close(): Promise<void> {
		this.shutdown.abort();
		await this.bridge.setInboundPort(0).catch(() => {});
		const closed = new Promise<void>(resolve => (this.server.listening ? this.server.close(() => resolve()) : resolve()));
		for (const socket of this.sockets) socket.destroy();
		await closed;
		this.addr = null;
		this.safeDispatchEvent('close');
	}
}

class OverlayTransport implements Transport {
	readonly [transportSymbol] = true;
	readonly [Symbol.toStringTag] = '@libershare/overlay';
	readonly [serviceCapabilities]: string[] = ['@libp2p/transport'];
	private readonly log: Logger;
	private readonly components: OverlayTransportComponents;
	private readonly bridge: OverlayBridge;

	constructor(components: OverlayTransportComponents, bridge: OverlayBridge) {
		this.components = components;
		this.bridge = bridge;
		this.log = components.logger.forComponent('libershare:overlay-transport');
	}

	async dial(ma: Multiaddr, options: DialTransportOptions): Promise<Connection> {
		const target = overlayTarget(ma, this.bridge.subnet);
		if (!target) throw new Error(`not an overlay address: ${ma.toString()}`);
		options.signal?.throwIfAborted();
		const socket = net.connect({ host: '127.0.0.1', port: this.bridge.dialPort, noDelay: true });
		try {
			await new Promise<void>((resolve, reject) => {
				const onAbort = (): void => reject(new AbortError());
				options.signal?.addEventListener('abort', onAbort, { once: true });
				socket.once('connect', () => {
					options.signal?.removeEventListener('abort', onAbort);
					resolve();
				});
				socket.once('error', reject);
			});
			socket.write(`${this.bridge.token} ${target.ip}:${target.port}\n`);
			const answer = await readLine(socket, options.signal);
			if (answer !== 'OK') throw new Error(`overlay dial to ${target.ip}:${target.port} failed: ${answer.replace(/^ERR /, '')}`);
		} catch (err) {
			socket.destroy();
			throw err;
		}
		const maConn = new OverlayConnection({ socket, remoteAddr: ma, direction: 'outbound', log: this.log.newScope('connection') });
		try {
			return await options.upgrader.upgradeOutbound(maConn, options);
		} catch (err: any) {
			maConn.abort(err);
			throw err;
		}
	}

	createListener(options: CreateListenerOptions): Listener {
		return new OverlayListener(this.bridge, options.upgrader, this.components.logger.forComponent('libershare:overlay-listener'));
	}

	listenFilter(multiaddrs: Multiaddr[]): Multiaddr[] {
		return multiaddrs.filter(ma => overlayTarget(ma, this.bridge.subnet) !== null);
	}

	dialFilter(multiaddrs: Multiaddr[]): Multiaddr[] {
		return this.listenFilter(multiaddrs);
	}
}

/** Transport factory for a libp2p config's `transports` list. */
export function overlayTransport(bridge: OverlayBridge): (components: OverlayTransportComponents) => Transport {
	return components => new OverlayTransport(components, bridge);
}
