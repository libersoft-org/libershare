import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { type PrivateKey } from '@libp2p/interface';
import { join } from 'path';
import { SqliteDatastore } from './datastore.ts';

/** Key under which the Ed25519 private key protobuf is stored in the datastore. */
export const PRIVATE_KEY_PATH = '/local/privatekey';

/**
 * Load the node's Ed25519 private key from the open datastore.
 * If no key is stored yet, generates a new one and persists it.
 */
export async function loadOrCreatePrivateKey(datastore: SqliteDatastore): Promise<PrivateKey> {
	try {
		if (await datastore.has(PRIVATE_KEY_PATH as any)) {
			const bytes = await datastore.get(PRIVATE_KEY_PATH as any);
			const privateKey = privateKeyFromProtobuf(bytes);
			console.log('✓ Loaded private key from datastore');
			return privateKey;
		}
	} catch (error) {
		console.log('Could not load private key:', error);
	}

	const privateKey = await generateKeyPair('Ed25519');
	const bytes = privateKeyToProtobuf(privateKey);
	await datastore.put(PRIVATE_KEY_PATH as any, bytes);
	console.log('✓ Saved new private key to datastore');
	return privateKey;
}

/**
 * Write a new identity private key into the datastore at the given data directory.
 * Opens and closes its own SqliteDatastore — the network must be stopped.
 * Validates the protobuf bytes before writing.
 */
export async function writeIdentityKey(dataDir: string, privateKeyBytes: Uint8Array): Promise<void> {
	// Validate first — throws if not a valid libp2p private key protobuf
	privateKeyFromProtobuf(privateKeyBytes);
	const datastorePath = join(dataDir, 'datastore');
	const ds = new SqliteDatastore(datastorePath);
	ds.open();
	try {
		ds.put(PRIVATE_KEY_PATH as any, privateKeyBytes);
	} finally {
		ds.close();
	}
}

/**
 * Delete the identity private key from the datastore at the given data directory.
 * Opens and closes its own SqliteDatastore — the network must be stopped.
 * Next start will generate a fresh key.
 */
export async function clearIdentityKey(dataDir: string): Promise<void> {
	const datastorePath = join(dataDir, 'datastore');
	const ds = new SqliteDatastore(datastorePath);
	ds.open();
	try {
		if (ds.has(PRIVATE_KEY_PATH as any)) ds.delete(PRIVATE_KEY_PATH as any);
	} finally {
		ds.close();
	}
}

/**
 * Wipe the entire datastore — peerstore (discovered peers, addresses) and the
 * identity private key. The network must be stopped. Next start regenerates a
 * fresh identity and an empty peerstore. Used by the factory reset.
 */
export async function clearDatastore(dataDir: string): Promise<void> {
	const datastorePath = join(dataDir, 'datastore');
	const ds = new SqliteDatastore(datastorePath);
	ds.open();
	try {
		ds.clear();
	} finally {
		ds.close();
	}
}
