/** A connected API session, shared by WebSocket and the inherited desktop pipe. */
export interface APIClient {
	data: { subscribedEvents: Set<string>; isLocalClient: boolean };
	send(message: string): unknown;
	close(): void;
}
