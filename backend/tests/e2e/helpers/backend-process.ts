import { Network } from '../../../src/protocol/network.ts';

// Discovery cannot verify a public address until another peer connects. The parent
// needs the actual bound endpoint for that first connection, not advertised addresses.
const start = Network.prototype.start;
Network.prototype.start = async function (bootstrapPeers: string[] = []): Promise<void> {
	await start.call(this, bootstrapPeers);
	const node = (this as unknown as { node: { components: { transportManager: { getAddrs(): Array<{ toString(): string }> } } } }).node;
	process.send?.({ type: 'listening', addresses: node.components.transportManager.getAddrs().map(address => address.toString()) });
};

await import('../../../src/app.ts');
