import { describe, it, expect, afterEach } from 'bun:test';
import net from 'node:net';
import { defaultLogger } from '@libp2p/logger';
import { multiaddr } from '@multiformats/multiaddr';
import { overlayTransport, overlayTarget, type OverlayBridge } from '../../../src/protocol/overlay-transport.ts';

const TOKEN = 'a'.repeat(40);
const SUBNET = '100.64.0.0/16';
const closers: (() => void)[] = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
});

/** A stand-in for the helper's dial port: checks the header, answers OK or ERR, then echoes. */
async function fakeHelper(answer: (header: string) => string): Promise<{ port: number; headers: string[] }> {
	const headers: string[] = [];
	const server = net.createServer(socket => {
		let buf = '';
		const onData = (chunk: Buffer): void => {
			buf += chunk.toString('latin1');
			const nl = buf.indexOf('\n');
			if (nl < 0) return;
			socket.off('data', onData);
			headers.push(buf.slice(0, nl));
			const reply = answer(buf.slice(0, nl));
			socket.write(reply + '\n');
			if (reply !== 'OK') return void socket.end();
			const rest = buf.slice(nl + 1);
			if (rest) socket.write(Buffer.from(rest, 'latin1'));
			socket.on('data', d => socket.write(d));
		};
		socket.on('data', onData);
		socket.on('error', () => {});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	closers.push(() => server.close());
	return { port: (server.address() as net.AddressInfo).port, headers };
}

function bridge(dialPort: number, inbound: number[] = []): OverlayBridge {
	return {
		dialPort,
		token: TOKEN,
		subnet: SUBNET,
		setInboundPort: async port => {
			inbound.push(port);
		},
	};
}

/** An upgrader that hands the raw bridged connection back, so the test sees exactly what the transport built. */
function rawUpgrader(seen: any[] = []): any {
	return {
		upgradeOutbound: async (maConn: any) => maConn,
		upgradeInbound: async (maConn: any) => {
			seen.push(maConn);
		},
	};
}

function firstMessage(conn: any): Promise<string> {
	return new Promise(resolve => conn.addEventListener('message', (evt: any) => resolve(new TextDecoder().decode(evt.data.subarray())), { once: true }));
}

describe('overlayTarget', () => {
	it('accepts only /ip4/<subnet address>/tcp/<port>', () => {
		expect(overlayTarget(multiaddr('/ip4/100.64.0.2/tcp/9090'), SUBNET)).toEqual({ ip: '100.64.0.2', port: 9090 });
		expect(overlayTarget(multiaddr('/ip4/100.64.3.9/tcp/9090/p2p/12D3KooWGzBgW1mHp7DpLbR2X5yfDN8dRtVYWNw2wXxu3yi1fYM5'), SUBNET)).toEqual({ ip: '100.64.3.9', port: 9090 });
		expect(overlayTarget(multiaddr('/ip4/203.0.113.5/tcp/9090'), SUBNET)).toBeNull();
		expect(overlayTarget(multiaddr('/ip4/192.168.99.4/tcp/9090'), SUBNET)).toBeNull();
		expect(overlayTarget(multiaddr('/ip6/::1/tcp/9090'), SUBNET)).toBeNull();
		expect(overlayTarget(multiaddr('/ip4/100.64.0.2/udp/9090/quic-v1'), SUBNET)).toBeNull();
		expect(overlayTarget(multiaddr('/ip4/100.64.0.2/tcp/9090/p2p/12D3KooWGzBgW1mHp7DpLbR2X5yfDN8dRtVYWNw2wXxu3yi1fYM5/p2p-circuit'), SUBNET)).toBeNull();
	});
});

describe('overlay transport dial', () => {
	it('sends the token and the overlay target, then carries the stream', async () => {
		const helper = await fakeHelper(() => 'OK');
		const transport = overlayTransport(bridge(helper.port))({ logger: defaultLogger() });
		const ma = multiaddr('/ip4/100.64.0.7/tcp/9090');
		const conn: any = await transport.dial(ma, { upgrader: rawUpgrader(), signal: AbortSignal.timeout(5000) } as any);
		expect(helper.headers).toEqual([`${TOKEN} 100.64.0.7:9090`]);
		expect(conn.remoteAddr.toString()).toBe('/ip4/100.64.0.7/tcp/9090');
		const echoed = firstMessage(conn);
		conn.send(new TextEncoder().encode('hello'));
		expect(await echoed).toBe('hello');
		conn.abort(new Error('done'));
	});

	it('fails with the helper reason and refuses addresses outside the overlay', async () => {
		const helper = await fakeHelper(() => 'ERR no route to 100.64.0.9');
		const transport = overlayTransport(bridge(helper.port))({ logger: defaultLogger() });
		await expect(transport.dial(multiaddr('/ip4/100.64.0.9/tcp/9090'), { upgrader: rawUpgrader(), signal: AbortSignal.timeout(5000) } as any)).rejects.toThrow('no route to 100.64.0.9');
		await expect(transport.dial(multiaddr('/ip4/203.0.113.5/tcp/9090'), { upgrader: rawUpgrader(), signal: AbortSignal.timeout(5000) } as any)).rejects.toThrow('not an overlay address');
		expect(helper.headers).toHaveLength(1);
	});
});

describe('overlay transport listener', () => {
	async function listen(): Promise<{ port: number; seen: any[]; inbound: number[]; close: () => Promise<void> }> {
		const inbound: number[] = [];
		const seen: any[] = [];
		const transport = overlayTransport(bridge(1, inbound))({ logger: defaultLogger() });
		const listener = transport.createListener({ upgrader: rawUpgrader(seen) } as any);
		await listener.listen(multiaddr('/ip4/100.64.0.1/tcp/9090'));
		expect(listener.getAddrs().map(a => a.toString())).toEqual(['/ip4/100.64.0.1/tcp/9090']);
		return { port: inbound[0]!, seen, inbound, close: () => listener.close() };
	}

	function send(port: number, data: string): net.Socket {
		const socket = net.connect({ host: '127.0.0.1', port });
		socket.on('error', () => {});
		socket.write(data);
		closers.push(() => socket.destroy());
		return socket;
	}

	it('takes the remote overlay address from the header and keeps the bytes behind it', async () => {
		const l = await listen();
		send(l.port, `${TOKEN} 100.64.0.7:41000\nfirst`);
		for (let i = 0; i < 50 && l.seen.length === 0; i++) await Bun.sleep(10);
		expect(l.seen).toHaveLength(1);
		expect(l.seen[0].remoteAddr.toString()).toBe('/ip4/100.64.0.7/tcp/41000');
		expect(await firstMessage(l.seen[0])).toBe('first');
		await l.close();
		expect(l.inbound).toEqual([l.port, 0]);
	});

	it('refuses a connection without the token or from outside the overlay', async () => {
		const l = await listen();
		const wrong = send(l.port, `${'b'.repeat(40)} 100.64.0.7:41000\n`);
		const outside = send(l.port, `${TOKEN} 203.0.113.5:41000\n`);
		await Promise.all([wrong, outside].map(s => new Promise(resolve => s.once('close', resolve))));
		expect(l.seen).toHaveLength(0);
		await l.close();
	});
});
