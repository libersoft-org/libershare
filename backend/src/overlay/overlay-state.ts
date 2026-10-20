import { createHash } from 'node:crypto';
import { privateKeyFromRaw, publicKeyFromRaw } from '@libp2p/crypto/keys';
import { CodedError, ErrorCodes, isOverlayLimit, MAX_LIMITS_PER_MEMBER, type LISHOverlayDefinition, type OverlayLimit, type OverlayState, type SignedOverlayState, validateOverlayHosts } from '@shared';

/** Prefix of every signed state, so a state signature can never pass for a Nebula certificate signature. */
const DOMAIN = 'lish-overlay-state/1\n';
/** Every approval adds a member limit (about 110 bytes) until it is compacted when it ends: room for thousands of members. */
const MAX_STATE_BYTES = 1024 * 1024;
const FINGERPRINT = /^[0-9a-f]{64}$/;
/** A certificate name: the member's libp2p peer ID (base58). */
const PEER_NAME = /^[1-9A-HJ-NP-Za-km-z]{40,64}$/;

function invalid(detail: string): CodedError {
	return new CodedError(ErrorCodes.NETWORK_INVALID, detail);
}

function pemBody(pem: string, banner: string): Uint8Array {
	const match = new RegExp(`-----BEGIN ${banner}-----([\\s\\S]*?)-----END ${banner}-----`).exec(pem);
	if (!match) throw invalid(`not a ${banner}`);
	return Uint8Array.from(Buffer.from(match[1]!.replace(/\s+/g, ''), 'base64'));
}

/** Sign `text` with the lishnet's CA key (Nebula's ed25519 signing key PEM); the signature as hex. */
async function signWithCA(text: string, caKeyPem: string): Promise<string> {
	const raw = pemBody(caKeyPem, 'NEBULA ED25519 PRIVATE KEY');
	if (raw.byteLength !== 64) throw invalid('the CA key is not an ed25519 key');
	return Buffer.from(await privateKeyFromRaw(raw).sign(new TextEncoder().encode(text))).toString('hex');
}

async function verifiedByCA(text: string, signature: string, caPublicKeyHex: string): Promise<boolean> {
	if (!/^[0-9a-f]{128}$/.test(signature)) return false;
	const key = publicKeyFromRaw(Uint8Array.from(Buffer.from(caPublicKeyHex, 'hex')));
	return await key.verify(new TextEncoder().encode(text), Uint8Array.from(Buffer.from(signature, 'hex')));
}

/** Sign a state with the lishnet's CA key. */
export async function signState(state: OverlayState, caKeyPem: string): Promise<SignedOverlayState> {
	const json = JSON.stringify(state);
	return { state: json, signature: await signWithCA(DOMAIN + json, caKeyPem) };
}

/** Prefix of a signed answer to a renewal, apart from states and certificates. */
const ANSWER_DOMAIN = 'lish-overlay-answer/1\n';

/** The founder's answer to the renewal request a member made at `requestCreated`: the certificate issued on it, or a refusal. */
export interface RenewalAnswer {
	networkID: string;
	peerID: string;
	requestCreated: string;
	/** The certificate (PEM) it approved with; absent for a refusal. */
	certificate?: string;
}

function answerText(answer: RenewalAnswer): string {
	const certificate = answer.certificate === undefined ? null : createHash('sha256').update(answer.certificate).digest('hex');
	return ANSWER_DOMAIN + JSON.stringify([answer.networkID, answer.peerID, answer.requestCreated, certificate]);
}

/**
 * Sign an answer with the CA key. A certificate alone proves only that the founder issued it once: another member
 * could hand an older one in as the answer to a new request, and a refusal would carry no proof at all.
 */
export async function signAnswer(answer: RenewalAnswer, caKeyPem: string): Promise<string> {
	return await signWithCA(answerText(answer), caKeyPem);
}

export async function verifyAnswer(answer: RenewalAnswer, signature: unknown, caPublicKeyHex: string): Promise<boolean> {
	return typeof signature === 'string' && (await verifiedByCA(answerText(answer), signature, caPublicKeyHex));
}

/**
 * Verify a signed state against the CA public key taken from the lishnet's definition — never against a key
 * that came with the state — and return the state it carries. Throws NETWORK_INVALID.
 */
export async function verifyState(signed: unknown, caPublicKeyHex: string, networkID: string, subnet: string): Promise<OverlayState> {
	if (typeof signed !== 'object' || signed === null) throw invalid('signed state must be an object');
	const { state, signature } = signed as Record<string, unknown>;
	if (typeof state !== 'string' || state.length > MAX_STATE_BYTES || typeof signature !== 'string' || !/^[0-9a-f]{128}$/.test(signature)) throw invalid('malformed signed state');
	if (!(await verifiedByCA(DOMAIN + state, signature, caPublicKeyHex))) throw invalid("the state is not signed by this lishnet's CA");
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(state);
	} catch {
		throw invalid('signed state is not JSON');
	}
	if (parsed['networkID'] !== networkID) throw invalid('the state belongs to another lishnet');
	const version = parsed['version'];
	if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) throw invalid('state version must be a positive integer');
	const revoked = parsed['revoked'];
	if (!Array.isArray(revoked) || revoked.some(f => typeof f !== 'string' || !FINGERPRINT.test(f))) throw invalid('state revocations must be certificate fingerprints');
	const lighthouses = validateOverlayHosts(parsed['lighthouses'], subnet, 'lighthouses');
	const relays = validateOverlayHosts(parsed['relays'], subnet, 'relays');
	// States signed before members could be revoked by peer ID have none.
	const peers = parsed['revokedPeers'] ?? {};
	if (typeof peers !== 'object' || peers === null || Array.isArray(peers)) throw invalid('state member revocations must be an object');
	for (const [peerID, at] of Object.entries(peers)) if (!PEER_NAME.test(peerID) || typeof at !== 'string' || Number.isNaN(Date.parse(at))) throw invalid('state member revocations must map peer IDs to times');
	const revokedPeers = peers as Record<string, string>;
	// States signed before approvals limited older certificates have none.
	const limits = parsed['limits'] ?? {};
	if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) throw invalid('state limits must be an object');
	for (const [peerID, list] of Object.entries(limits)) if (!PEER_NAME.test(peerID) || !Array.isArray(list) || list.length > MAX_LIMITS_PER_MEMBER || !list.every(isOverlayLimit)) throw invalid('state limits must map peer IDs to member limits');
	const memberLimits = limits as Record<string, OverlayLimit[]>;
	return { networkID, version, lighthouses, relays, revoked: [...new Set(revoked as string[])], ...(Object.keys(revokedPeers).length > 0 ? { revokedPeers } : {}), ...(Object.keys(memberLimits).length > 0 ? { limits: memberLimits } : {}) };
}

/** The definition with the hosts of a newer verified state. */
export function applyState(overlay: LISHOverlayDefinition, state: OverlayState): LISHOverlayDefinition {
	return { ...overlay, lighthouses: state.lighthouses, relays: state.relays, version: state.version };
}

/** A version newer than both the current one and the clock, so states from two devices holding the CA never collide. */
export function nextVersion(current: number): number {
	return Math.max(current + 1, Date.now());
}
