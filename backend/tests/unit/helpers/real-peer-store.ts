import { multiaddr } from '@multiformats/multiaddr';
import { persistentPeerStore } from '@libp2p/peer-store';
import { MemoryDatastore } from 'datastore-core';
import { defaultLogger } from '@libp2p/logger';
import { peerIdFromString } from '@libp2p/peer-id';
import { TypedEventEmitter } from 'main-event';

/**
 * A real `@libp2p/peer-store` over an in-memory datastore.
 *
 * Hand-written peerStore stand-ins have hidden two production bugs already: the store
 * strips a trailing `/p2p/<id>` before writing, so a stub built in the shape the code
 * expected passed while the real trim matched nothing; and the removal path now takes
 * the store's own per-peer lock, which only the real store has. Anything asserting what
 * the peerStore actually holds is built on this.
 */
export interface IRealPeerStore {
	/** The store, in the shape `Network` expects on `node.peerStore`. */
	store: any;
	/** Parsed ID of the peer the test is about. */
	pid: any;
}

/** Identity of the store itself. A valid ID that is never one of the peers under test. */
const STORE_SELF_ID = '12D3KooWH3uVF6wv47WnArKHk5p6cvgCJEb74UTmxztmQDc298L3';

/** An empty store. Every peer reads as absent until something is written for it. */
export function createEmptyPeerStore(): any {
	return persistentPeerStore({
		peerId: peerIdFromString(STORE_SELF_ID),
		// Cast: two copies of interface-datastore are installed (libp2p nests its own)
		// and their Key classes are structurally incompatible. Runtime is one class.
		datastore: new MemoryDatastore() as any,
		events: new TypedEventEmitter() as any,
		logger: defaultLogger(),
	});
}

/** An empty store plus `addresses` written for `peerID`. */
export async function createRealPeerStore(peerID: string, addresses: readonly string[] = []): Promise<IRealPeerStore> {
	const store = createEmptyPeerStore();
	const pid = peerIdFromString(peerID);
	if (addresses.length > 0) await store.patch(pid, { multiaddrs: addresses.map(a => multiaddr(a)) });
	return { store, pid };
}

/** The addresses the store currently holds for the peer, as strings. */
export async function storedAddresses(realStore: IRealPeerStore): Promise<string[]> {
	try {
		return (await realStore.store.get(realStore.pid)).addresses.map((a: { multiaddr: { toString(): string } }) => a.multiaddr.toString());
	} catch {
		// No record at all — the same observable outcome as holding no addresses.
		return [];
	}
}
