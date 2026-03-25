/** Minimal Network stub for unit tests. Satisfies the interface used by Downloader without starting libp2p. */
export class MockNetwork {
	/** Recorded subscribe calls — tests can assert on this. */
	readonly subscribedTopics: Array<{ topic: string; handler: (data: Record<string, unknown>) => void }> = [];

	private handlers = new Map<string, Set<(data: Record<string, unknown>) => void>>();

	subscribe(topic: string, handler: (data: Record<string, unknown>) => void): void {
		if (!this.handlers.has(topic)) this.handlers.set(topic, new Set());
		this.handlers.get(topic)!.add(handler);
		this.subscribedTopics.push({ topic, handler });
	}

	unsubscribeHandler(topic: string, handler: (data: Record<string, unknown>) => void): void {
		this.handlers.get(topic)?.delete(handler);
	}

	async broadcast(_topic: string, _data: Record<string, unknown>): Promise<void> {
		// no-op in tests
	}

	async dialProtocol(_multiaddrs: unknown[], _protocol: string): Promise<never> {
		throw new Error('MockNetwork.dialProtocol: not implemented in unit tests');
	}

	async dialProtocolByPeerId(_peerID: string, _protocol: string): Promise<never> {
		throw new Error('MockNetwork.dialProtocolByPeerId: not implemented in unit tests');
	}

	getTopicPeers(_networkID: string): string[] {
		return [];
	}

	isRunning(): boolean {
		return false;
	}
}
