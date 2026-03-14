import { canonicalize } from 'json-canonicalize';
import { peerIdFromString } from '@libp2p/peer-id';
import type { Ed25519PrivateKey } from '@libp2p/interface';
import { hlcTick, type HLC } from './catalog-hlc.ts';

export interface CatalogOpPayload {
	type: 'add' | 'update' | 'remove' | 'acl_grant' | 'acl_revoke';
	networkID: string;
	hlc: HLC;
	nonce: string;
	data: Record<string, unknown>;
}

export interface SignedCatalogOp {
	payload: CatalogOpPayload;
	signature: string;
	signer: string;
	keyType: 'Ed25519';
}

const encoder = new TextEncoder();

export async function signCatalogOp(
	privateKey: Ed25519PrivateKey,
	type: CatalogOpPayload['type'],
	networkID: string,
	data: Record<string, unknown>,
	localClock: HLC,
): Promise<{ op: SignedCatalogOp; updatedClock: HLC }> {
	const newClock = hlcTick(localClock);
	const payload: CatalogOpPayload = {
		type,
		networkID,
		hlc: newClock,
		nonce: crypto.randomUUID(),
		data,
	};
	const canonical = canonicalize(payload);
	const bytes = encoder.encode(canonical);
	const sig = await privateKey.sign(bytes);
	return {
		op: {
			payload,
			signature: Buffer.from(sig).toString('base64url'),
			signer: privateKey.publicKey.toString(),
			keyType: 'Ed25519',
		},
		updatedClock: newClock,
	};
}

export async function verifyCatalogOp(op: SignedCatalogOp): Promise<boolean> {
	try {
		const peerId = peerIdFromString(op.signer);
		if (peerId.type !== 'Ed25519') return false;
		const canonical = canonicalize(op.payload);
		const bytes = encoder.encode(canonical);
		const sig = Buffer.from(op.signature, 'base64url');
		return peerId.publicKey!.verify(bytes, sig);
	} catch {
		return false;
	}
}
