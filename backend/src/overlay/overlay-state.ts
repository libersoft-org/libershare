import { privateKeyFromRaw, publicKeyFromRaw } from '@libp2p/crypto/keys';
import { CodedError, ErrorCodes, type LISHOverlayDefinition, type OverlayState, type SignedOverlayState, validateOverlayHosts } from '@shared';

/** Prefix of every signed state, so a state signature can never pass for a Nebula certificate signature. */
const DOMAIN = 'lish-overlay-state/1\n';
const MAX_STATE_BYTES = 200 * 1024;
const FINGERPRINT = /^[0-9a-f]{64}$/;

function invalid(detail: string): CodedError {
	return new CodedError(ErrorCodes.NETWORK_INVALID, detail);
}

function pemBody(pem: string, banner: string): Uint8Array {
	const match = new RegExp(`-----BEGIN ${banner}-----([\\s\\S]*?)-----END ${banner}-----`).exec(pem);
	if (!match) throw invalid(`not a ${banner}`);
	return Uint8Array.from(Buffer.from(match[1]!.replace(/\s+/g, ''), 'base64'));
}

/** Sign a state with the lishnet's CA key (Nebula's ed25519 signing key PEM). */
export async function signState(state: OverlayState, caKeyPem: string): Promise<SignedOverlayState> {
	const raw = pemBody(caKeyPem, 'NEBULA ED25519 PRIVATE KEY');
	if (raw.byteLength !== 64) throw invalid('the CA key is not an ed25519 key');
	const json = JSON.stringify(state);
	const signature = await privateKeyFromRaw(raw).sign(new TextEncoder().encode(DOMAIN + json));
	return { state: json, signature: Buffer.from(signature).toString('hex') };
}

/**
 * Verify a signed state against the CA public key taken from the lishnet's definition — never against a key
 * that came with the state — and return the state it carries. Throws NETWORK_INVALID.
 */
export async function verifyState(signed: unknown, caPublicKeyHex: string, networkID: string, subnet: string): Promise<OverlayState> {
	if (typeof signed !== 'object' || signed === null) throw invalid('signed state must be an object');
	const { state, signature } = signed as Record<string, unknown>;
	if (typeof state !== 'string' || state.length > MAX_STATE_BYTES || typeof signature !== 'string' || !/^[0-9a-f]{128}$/.test(signature)) throw invalid('malformed signed state');
	const key = publicKeyFromRaw(Uint8Array.from(Buffer.from(caPublicKeyHex, 'hex')));
	if (!(await key.verify(new TextEncoder().encode(DOMAIN + state), Uint8Array.from(Buffer.from(signature, 'hex'))))) throw invalid("the state is not signed by this lishnet's CA");
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
	return { networkID, version, lighthouses, relays, revoked: [...new Set(revoked as string[])] };
}

/** The definition with the hosts of a newer verified state. */
export function applyState(overlay: LISHOverlayDefinition, state: OverlayState): LISHOverlayDefinition {
	return { ...overlay, lighthouses: state.lighthouses, relays: state.relays, version: state.version };
}

/** A version newer than both the current one and the clock, so states from two devices holding the CA never collide. */
export function nextVersion(current: number): number {
	return Math.max(current + 1, Date.now());
}
