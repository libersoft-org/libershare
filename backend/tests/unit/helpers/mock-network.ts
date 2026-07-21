import type { Stream } from '@libp2p/interface';

type TopicHandler = (data: Record<string, any>) => void;

/** Mock Network for unit testing Downloader and Catalog without real libp2p. */
export class MockNetwork {
	readonly subscribedTopics: Array<{ topic: string; handler: TopicHandler }> = [];
	readonly broadcastMessages: Array<{ topic: string; data: Record<string, any> }> = [];
	readonly dialCalls: Array<{ peerID: string; protocol: string }> = [];

	private handlers = new Map<string, Set<TopicHandler>>();
	private topicPeers: string[] = [];
	private dialResults = new Map<string, Stream | Error>();

	setTopicPeers(peers: string[]): void {
		this.topicPeers = peers;
	}

	setDialResult(peerID: string, result: Stream | Error): void {
		this.dialResults.set(peerID, result);
	}

	subscribe(topic: string, handler: TopicHandler): void {
		if (!this.handlers.has(topic)) this.handlers.set(topic, new Set());
		this.handlers.get(topic)!.add(handler);
		this.subscribedTopics.push({ topic, handler });
	}

	unsubscribeHandler(topic: string, handler: TopicHandler): void {
		this.handlers.get(topic)?.delete(handler);
	}

	async broadcast(topic: string, data: Record<string, any>): Promise<void> {
		this.broadcastMessages.push({ topic, data });
	}

	getTopicPeers(_networkID: string): string[] {
		return [...this.topicPeers];
	}

	async dialProtocol(_multiaddrs: unknown[], _protocol: string): Promise<never> {
		throw new Error('MockNetwork.dialProtocol: not implemented in unit tests');
	}

	async dialProtocolByPeerId(peerID: string, protocol: string): Promise<Stream> {
		this.dialCalls.push({ peerID, protocol });
		const result = this.dialResults.get(peerID);
		if (!result) throw new Error(`MockNetwork: no dial result configured for peer ${peerID}`);
		if (result instanceof Error) throw result;
		return result;
	}

	isRunning(): boolean {
		return false;
	}

	/** Simulate receiving a pubsub message on a subscribed topic. */
	simulateMessage(topic: string, data: Record<string, any>): void {
		for (const sub of this.subscribedTopics) {
			if (sub.topic === topic) sub.handler(data);
		}
	}
}
