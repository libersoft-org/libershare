import { describe, expect, it } from 'bun:test';
import { Network } from '../../../src/protocol/network.ts';
import { fakeLISHStream } from '../helpers/lish-stream.ts';

/**
 * Every gate of the LISH protocol (who may list, fetch a manifest, take chunks) and every announcement (HAVE,
 * search results) is decided on the sender of the stream. libp2p 3 hands the handler (stream, connection); the
 * sender has to come from that connection. Stream ids count per connection, so looking a stream up by its id among
 * all connections found whichever peer happened to have a stream with the same number.
 */
describe('LISH protocol sender', () => {
	it('is the peer of the connection the stream arrived on, not another with a same-numbered stream', async () => {
		const network = new Network('/tmp/lish-handler-sender', {} as never, {} as never);
		const internals = network as unknown as Record<string, any>;
		const { stream } = fakeLISHStream([{ type: 'getLish', lishID: 'some-lish' }]);
		const otherStream = { id: (stream as any).id };
		const peer = (id: string): any => ({ toString: () => id });
		const connections: Record<string, any[]> = {
			'peer-other': [{ remotePeer: peer('peer-other'), remoteAddr: undefined, streams: [otherStream] }],
			'peer-sender': [{ remotePeer: peer('peer-sender'), remoteAddr: undefined, streams: [stream] }],
		};
		internals['node'] = { getPeers: () => [peer('peer-other'), peer('peer-sender')], getConnections: (p: any) => connections[p.toString()] ?? [] };
		const asked: string[] = [];
		internals['sharesJoinedTopicWith'] = (pid: string) => {
			asked.push(pid);
			return false;
		};
		internals['canListSharesTo'] = () => false;
		await internals['handleInboundLISHProtocol'](stream, connections['peer-sender']![0]);
		expect(asked).toEqual(['peer-sender']);
	});
});
