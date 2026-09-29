import { expect, it } from 'bun:test';
import { connect, type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import { multiaddr } from '@multiformats/multiaddr';
import { TCPListener } from '../../../node_modules/@libp2p/tcp/dist/src/listener.js';

for (const allowHalfOpen of [false, true]) {
	it(`closes a TCP listener with an unread outgoing buffer (allowHalfOpen=${allowHalfOpen})`, async () => {
		const log = Object.assign(() => {}, { error() {}, trace() {} });
		const listener = new TCPListener({ logger: { forComponent: () => log }, upgrader: { upgradeInbound: async () => {} }, allowHalfOpen, inactivityTimeout: 60_000 } as never);
		const server = (listener as unknown as { server: Server }).server;
		let peer: Socket | undefined;
		let socket: Socket | undefined;
		let closing: Promise<void> | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await listener.listen(multiaddr('/ip4/127.0.0.1/tcp/0'));
			const accepted = once(server, 'connection');
			const address = server.address();
			if (!address || typeof address === 'string') throw new Error('Missing TCP address');
			peer = connect({ host: '127.0.0.1', port: address.port, allowHalfOpen: true });
			peer.pause();
			await once(peer, 'connect');
			[socket] = (await accepted) as [Socket];
			const ended = once(socket, 'end');
			socket.write(Buffer.alloc(32 * 1024 * 1024, 1));
			peer.end();
			await ended;
			expect(socket.readable).toBe(false);
			closing = listener.close();
			const stopped = await Promise.race([
				closing.then(() => true),
				new Promise<false>(resolve => {
					timer = setTimeout(() => resolve(false), 500);
				}),
			]);
			expect(stopped).toBe(true);
			expect(socket.destroyed).toBe(true);
		} finally {
			clearTimeout(timer);
			peer?.destroy();
			socket?.destroy();
			await (closing ?? listener.close());
		}
	});
}
