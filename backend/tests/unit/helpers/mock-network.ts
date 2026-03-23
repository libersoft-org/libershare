import type { Stream } from '@libp2p/interface';

type TopicHandler = (data: Record<string, any>) => void;

export interface DialResult {
	stream: Stream;
	error?: never;
}

export interface DialError {
	stream?: never;
	error: Error;
}

/**
 * Mock Network for unit testing Downloader without real libp2p.
 *
 * Configurable behaviour:
 * - topicPeers: peers returned by getTopicPeers()
 * - dialResults: map of peerID → Stream (or Error to simulate failures)
 * - subscribedTopics: recorded subscribe() calls
 * - broadcastMessages: recorded broadcast() calls
 */
export class MockNetwork {
	private topicPeers: string[];
	private dialResults: Map<string, Stream | Error>;
	readonly subscribedTopics: Array<{ topic: string; handler: TopicHandler }> = [];
	readonly broadcastMessages: Array<{ topic: string; data: Record<string, any> }> = [];
	readonly dialCalls: Array<{ peerID: string; protocol: string }> = [];

	constructor(opts: {
		topicPeers?: string[];
		dialResults?: Map<string, Stream | Error>;
	} = {}) {
		this.topicPeers = opts.topicPeers ?? [];
		this.dialResults = opts.dialResults ?? new Map();
	}

	setTopicPeers(peers: string[]): void {
		this.topicPeers = peers;
	}

	setDialResult(peerID: string, result: Stream | Error): void {
		this.dialResults.set(peerID, result);
	}

	async subscribe(topic: string, handler: TopicHandler): Promise<void> {
		this.subscribedTopics.push({ topic, handler });
	}

	async broadcast(topic: string, data: Record<string, any>): Promise<void> {
		this.broadcastMessages.push({ topic, data });
	}

	getTopicPeers(_networkID: string): string[] {
		return [...this.topicPeers];
	}

	async dialProtocolByPeerId(peerID: string, protocol: string): Promise<Stream> {
		this.dialCalls.push({ peerID, protocol });
		const result = this.dialResults.get(peerID);
		if (!result) throw new Error(`MockNetwork: no dial result configured for peer ${peerID}`);
		if (result instanceof Error) throw result;
		return result;
	}

	/** Simulate receiving a pubsub message on a subscribed topic. */
	simulateMessage(topic: string, data: Record<string, any>): void {
		for (const sub of this.subscribedTopics) {
			if (sub.topic === topic) sub.handler(data);
		}
	}
}
