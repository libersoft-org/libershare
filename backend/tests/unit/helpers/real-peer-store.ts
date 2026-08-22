import { multiaddr } from '@multiformats/multiaddr';
import { persistentPeerStore } from '@libp2p/peer-store';
import { MemoryDatastore } from 'datastore-core';
import { defaultLogger } from '@libp2p/logger';
import { peerIdFromString } from '@libp2p/peer-id';
import { TypedEventEmitter } from 'main-event';
import { isPeerStoreNotFound } from '../../../src/protocol/network.ts';

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

/**
 * A memory datastore that can be told to fail one specific read.
 *
 * `store.patch()` performs its OWN `datastore.get()` after the one the caller made, and
 * upstream used to swallow every error from it and write as if the peer had never
 * existed. Only a fault injected at the datastore reaches that hidden second read —
 * stubbing `load` or `patch` steps over it entirely.
 */
export class FaultyDatastore extends MemoryDatastore {
	/** Reads to let through before the next one fails, or `null` for no armed fault. */
	private goodReadsLeft: number | null = null;

	/** Reads to let through before the next one finds its key gone, or `null` for none. */
	private readsBeforeVanish: number | null = null;

	/** Every `put()` this store has been asked to make. */
	writes = 0;

	/** Arm a single read failure, after `skip` further reads have succeeded. */
	failReadAfter(skip: number): void {
		this.goodReadsLeft = skip;
	}

	/**
	 * Arm a single read that finds its record deleted, after `skip` further reads.
	 *
	 * The record really is removed, so the read raises the datastore's own
	 * `NotFoundError` — the same thing `all()` cleaning up an expired snapshot or a TTL
	 * boundary crossed mid-call produces, and not a synthetic error the code could tell
	 * apart from the genuine one.
	 */
	vanishReadAfter(skip: number): void {
		this.readsBeforeVanish = skip;
	}

	override put(key: any, val: any, options?: any): any {
		this.writes++;
		return super.put(key, val, options);
	}

	override get(key: any, options?: any): any {
		if (this.readsBeforeVanish !== null) {
			if (this.readsBeforeVanish === 0) {
				this.readsBeforeVanish = null;
				super.delete(key, options);
			} else {
				this.readsBeforeVanish--;
			}
		}
		if (this.goodReadsLeft !== null) {
			if (this.goodReadsLeft === 0) {
				this.goodReadsLeft = null;
				throw Object.assign(new Error('datastore read failed'), { name: 'DatastoreReadError' });
			}
			this.goodReadsLeft--;
		}
		return super.get(key, options);
	}
}

/**
 * A memory datastore that runs a hook after `query()` has taken its snapshot.
 *
 * `SqliteDatastore` loads every matching row into an array before yielding the first one,
 * so `peerStore.all()` judges each peer against a snapshot taken before it started —
 * while ordinary locked writes keep landing. The hook is where such a write goes.
 */
export class SnapshotBarrierDatastore extends MemoryDatastore {
	/** Run once, after the next `query()` snapshot and before any row is yielded. */
	onSnapshot: (() => Promise<void>) | null = null;

	override async *query(q: any, options?: any): any {
		const rows: any[] = [];
		for await (const row of super.query(q, options)) rows.push(row);
		const hook = this.onSnapshot;
		this.onSnapshot = null;
		if (hook !== null) await hook();
		yield* rows;
	}
}

/**
 * The `/peers/...` rows the datastore PHYSICALLY holds, as key strings.
 *
 * `has()` and `get()` both go through `load()`, which deletes an expired record itself —
 * so they answer "gone" for a row the expiry sweep never touched, and a sweep that stopped
 * cleaning up entirely would still look healthy through them.
 */
export async function storedPeerRows(datastore: any): Promise<string[]> {
	const keys: string[] = [];
	for await (const { key } of datastore.query({ prefix: '/peers' })) keys.push(key.toString());
	return keys;
}

/** An empty store. Every peer reads as absent until something is written for it. */
export function createEmptyPeerStore(datastore: any = new MemoryDatastore(), init: Record<string, unknown> = {}): any {
	return persistentPeerStore(
		{
			// Cast: peer-store carries its own newer @libp2p/interface, whose PeerId types are
			// structurally incompatible with the hoisted copy libp2p uses. `isPeerId` and the
			// peer-id brand go through `Symbol.for`, so both copies agree at runtime.
			peerId: peerIdFromString(STORE_SELF_ID) as any,
			// Cast: two copies of interface-datastore are installed (libp2p nests its own)
			// and their Key classes are structurally incompatible. Runtime is one class.
			datastore: datastore as any,
			events: new TypedEventEmitter() as any,
			logger: defaultLogger(),
		},
		init
	);
}

/** An empty store plus `addresses` written for `peerID`. */
export async function createRealPeerStore(peerID: string, addresses: readonly string[] = [], datastore: any = new MemoryDatastore()): Promise<IRealPeerStore> {
	const store = createEmptyPeerStore(datastore);
	const pid = peerIdFromString(peerID);
	if (addresses.length > 0) await store.patch(pid, { multiaddrs: addresses.map(a => multiaddr(a)) });
	return { store, pid };
}

/**
 * The addresses the store currently holds for the peer, as strings.
 *
 * Only "the peer is not stored" reads as an empty list. Swallowing every read error the
 * way production once did would let a test asserting an empty result pass on a datastore
 * fault or a corrupt record — the exact conflation these tests exist to catch.
 */
export async function storedAddresses(realStore: IRealPeerStore): Promise<string[]> {
	try {
		return (await realStore.store.get(realStore.pid)).addresses.map((a: { multiaddr: { toString(): string } }) => a.multiaddr.toString());
	} catch (err: unknown) {
		if (!isPeerStoreNotFound(err)) throw err;
		return [];
	}
}
