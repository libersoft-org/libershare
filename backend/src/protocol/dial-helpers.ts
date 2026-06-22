import { Circuit } from '@multiformats/multiaddr-matcher';
import { multiaddr as Multiaddr } from '@multiformats/multiaddr';
import { type IDialResult } from './network.ts';
import { trace } from '../logger.ts';

/**
 * Classify a peer connection as DIRECT, RELAY, or DCUtR-upgraded based on
 * the circuit-relay flag and the dcutrPeers set owned by Network.
 */
export function classifyConnection(peerID: string, isRelay: boolean, dcutrPeers: Set<string>): 'DIRECT' | 'RELAY' | 'DCUtR' {
	const isDcutr = dcutrPeers.has(peerID);
	const result = isDcutr && !isRelay ? 'DCUtR' : isRelay ? 'RELAY' : 'DIRECT';
	trace(`[NET] classify ${peerID.slice(0, 12)}: relay=${isRelay} dcutrSet=${isDcutr} → ${result}`);
	return result;
}

/**
 * Dial a set of multiaddrs, open a protocol stream, and return the stream
 * together with the resolved connection type.
 */
export async function dialProtocol(node: any, dcutrPeers: Set<string>, multiaddrs: any[], protocol: string): Promise<IDialResult> {
	trace(`[NET] dial ${protocol} to ${multiaddrs.map((m: any) => m.toString()).join(', ')}`);
	const connection = await node.dial(multiaddrs);
	const peerID = connection.remotePeer.toString();
	const isRelay = Circuit.matches(connection.remoteAddr);
	const connectionType = classifyConnection(peerID, isRelay, dcutrPeers);
	const limited = (connection as any).limits != null;
	console.debug(`[NET] dial connected: ${peerID.slice(0, 16)} [${connectionType}${limited ? ',LIMITED' : ''}] addr=${connection.remoteAddr.toString().slice(0, 60)}`);
	const stream = await connection.newStream(protocol, { runOnLimitedConnection: true });
	trace(`[NET] stream opened: id=${stream.id}, status=${stream.status}`);
	return { stream, connectionType };
}

/**
 * Dial a peer by its string peer ID, open a protocol stream, and return the
 * stream together with the resolved connection type.
 */
export async function dialProtocolByPeerId(node: any, dcutrPeers: Set<string>, peerID: string, protocol: string): Promise<IDialResult> {
	trace(`[NET] dial ${protocol} to ${peerID.slice(0, 16)}`);
	const { peerIdFromString } = await import('@libp2p/peer-id');
	const pid = peerIdFromString(peerID);
	const connection = await node.dial(pid);
	const isRelay = Circuit.matches(connection.remoteAddr);
	const connectionType = classifyConnection(peerID, isRelay, dcutrPeers);
	const limited = (connection as any).limits != null;
	console.debug(`[NET] dial connected: ${peerID.slice(0, 16)} [${connectionType}${limited ? ',LIMITED' : ''}] addr=${connection.remoteAddr.toString().slice(0, 60)}`);
	const stream = await connection.newStream(protocol, { runOnLimitedConnection: true });
	trace(`[NET] stream opened: id=${stream.id}, status=${stream.status}`);
	return { stream, connectionType };
}

/**
 * Connect to a peer by multiaddr string (fire-and-forget dial, no stream).
 */
export async function connectToPeer(node: any, multiaddr: string): Promise<void> {
	const ma = Multiaddr(multiaddr);
	await node.dial(ma);
	console.debug('→ Connected to:', multiaddr);
}
