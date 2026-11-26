import { randomUUID } from 'node:crypto';
import { peerIdFromString } from '@libp2p/peer-id';
import { CodedError, ErrorCodes, decodeSignature, isSignedLISH, signedManifestBytes, validateSignedLISHShape, type ILISH, type LISHChecks, type UnverifiedLISH } from '@shared';
import { lishIDMatchesPublisher } from './lish-id.ts';

/**
 * Publisher a manifest must name: `string` for a known publisher, `null` for an explicitly
 * unsigned one, `undefined` when nothing is known yet.
 */
export type ExpectedPublisher = string | null | undefined;

/** How long a manifest waits for the user's answer, and how many and how much may wait at once. */
export interface PendingLimits {
	readonly ttlMs: number;
	readonly count: number;
	/** Estimated size of all waiting manifests together, see {@link heldWeight}. */
	readonly bytes: number;
}
const PENDING_LIMITS: PendingLimits = { ttlMs: 10 * 60 * 1000, count: 256, bytes: 256 * 1024 * 1024 };

/**
 * Rough size in memory of what a question holds. It walks the value itself instead of the fields
 * a manifest should have, so a field nobody expects, or one longer than it should be, counts too.
 * Every object and every value counts for something, so empty ones cannot pile up for free.
 */
function heldWeight(held: unknown): number {
	let weight = 0;
	// A list of its own rather than recursion: a field nobody defined can nest deeper than the call stack.
	const todo: unknown[] = [held];
	while (todo.length > 0) {
		const value = todo.pop();
		if (typeof value === 'string') weight += 16 + value.length;
		else if (typeof value !== 'object' || value === null) weight += 8;
		else {
			weight += 32;
			if (Array.isArray(value)) for (const item of value) todo.push(item);
			else
				for (const key in value) {
					weight += key.length;
					todo.push((value as Record<string, unknown>)[key]);
				}
		}
	}
	return weight;
}

interface Inspection {
	readonly checks: LISHChecks;
	/** The first check that failed, `null` when the manifest is verified. */
	readonly fault: CodedError | null;
}

interface Pending<T> {
	readonly token: string;
	readonly weight: number;
	readonly resume: () => Promise<T>;
	readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * The one place that decides whether a manifest may be taken in. Every way a LISH gets into this
 * node goes through it: an import, an add from a peer, a download from a local file, a preview
 * and the downloader fetching a manifest on its own.
 *
 * A manifest is verified when it is signed, the signature is its publisher's and its ID is the
 * one that publisher derives. Anything else may still be added, but only after the user agreed;
 * until then the manifest waits here, so what gets added is exactly what the user was asked about.
 */
export class ManifestAdmission<T> {
	// One waiting manifest per LISH ID: asking again about the same ID replaces the earlier one.
	private readonly pending = new Map<string, Pending<T>>();
	private pendingBytes = 0;
	private readonly limits: PendingLimits;

	constructor(limits: PendingLimits = PENDING_LIMITS) {
		this.limits = limits;
	}

	/** Run the three checks. Only a signed manifest with a malformed shape throws (`LISH_INVALID_MANIFEST`). */
	static async check(lish: ILISH): Promise<LISHChecks> {
		return (await ManifestAdmission.inspect(lish)).checks;
	}

	private static async inspect(lish: ILISH): Promise<Inspection> {
		if (!isSignedLISH(lish)) return { checks: { signed: false }, fault: new CodedError(ErrorCodes.LISH_UNSIGNED, lish.id) };
		validateSignedLISHShape(lish);
		const signatureFault = await ManifestAdmission.signatureFault(lish);
		const idMatchesPublisher = lishIDMatchesPublisher(lish);
		const checks: LISHChecks = { signed: true, signatureValid: signatureFault === null, idMatchesPublisher };
		if (signatureFault !== null) return { checks, fault: new CodedError(ErrorCodes.LISH_INVALID_SIGNATURE, signatureFault) };
		// A valid signature under an ID made for another key: the signer took over someone else's ID.
		if (!idMatchesPublisher) return { checks, fault: new CodedError(ErrorCodes.LISH_ID_MISMATCH, `${lish.id} is not an ID of ${lish.publisher}`) };
		return { checks, fault: null };
	}

	/** Why the signature does not hold, `null` when it does. */
	private static async signatureFault(lish: ILISH): Promise<string | null> {
		let peerID;
		try {
			peerID = peerIdFromString(lish.publisher!);
		} catch {
			return 'publisher is not a Peer ID';
		}
		// The publisher string is part of the signed bytes, so only its one canonical spelling counts.
		if (peerID.toString() !== lish.publisher) return 'publisher is not in canonical form';
		if (peerID.type !== 'Ed25519' || !peerID.publicKey) return 'publisher key is not Ed25519';
		const ok = await peerID.publicKey.verify(signedManifestBytes(lish), decodeSignature(lish.signature!));
		return ok ? null : 'signature does not match the manifest';
	}

	/**
	 * Take a manifest nobody can be asked about (the downloader fetching it on its own, a node
	 * checking what it just signed). An unsigned one passes, a signed one must be verified. Returns
	 * the publisher, `null` for an unsigned manifest.
	 */
	static async requireUnattended(lish: ILISH, expected?: ExpectedPublisher): Promise<string | null> {
		const { checks, fault } = await ManifestAdmission.inspect(lish);
		if (checks.signed && fault) throw fault;
		ManifestAdmission.assertExpected(lish, expected);
		return checks.signed ? lish.publisher! : null;
	}

	/** Throw `LISH_PUBLISHER_MISMATCH` when the manifest names another publisher than expected. */
	static assertExpected(lish: ILISH, expected: ExpectedPublisher): void {
		if (expected === undefined) return;
		const named = isSignedLISH(lish) ? (lish.publisher ?? '') : null;
		if (named !== expected) throw new CodedError(ErrorCodes.LISH_PUBLISHER_MISMATCH, `expected ${expected ?? 'unsigned'}, got ${named ?? 'unsigned'}`);
	}

	/**
	 * Take a manifest a user is adding and can be asked about. A verified one passes; any other
	 * passes only with `accepted`, and is refused with one of the unverified codes otherwise.
	 */
	static async gate(lish: ILISH, accepted: boolean): Promise<LISHChecks> {
		const { checks, fault } = await ManifestAdmission.inspect(lish);
		if (fault && !accepted) throw ManifestAdmission.unverified(lish, checks, fault);
		return checks;
	}

	/**
	 * {@link gate} for a manifest this node holds while it asks: an unverified one is kept and the
	 * refusal carries its token. `resume` adds the manifest; it runs at once for a verified or
	 * accepted manifest, or later from {@link answer}. `refuse` throws for a manifest that cannot be
	 * added whatever the user says, so nobody is asked about one of those.
	 */
	async admit(lish: ILISH, accepted: boolean, resume: (checks: LISHChecks) => Promise<T>, refuse?: (checks: LISHChecks) => void): Promise<T> {
		const { checks, fault } = await ManifestAdmission.inspect(lish);
		refuse?.(checks);
		if (fault && !accepted)
			throw ManifestAdmission.unverified(
				lish,
				checks,
				fault,
				this.park(lish.id, lish, () => resume(checks))
			);
		this.drop(lish.id);
		return resume(checks);
	}

	/**
	 * {@link admit} for the manifests of one request. Nothing is added until all of them may be,
	 * and one question stands for them all: its answer adds what was read for the request, never
	 * what reading the source again would bring. The refusal names the first manifest that failed
	 * a check, or else the first unsigned one, so the stronger warning is the one reported.
	 */
	async admitAll(lishs: readonly ILISH[], accepted: boolean, resume: () => Promise<T>): Promise<T> {
		const unverified: Array<{ lish: ILISH; checks: LISHChecks; fault: CodedError }> = [];
		for (const lish of lishs) {
			const { checks, fault } = await ManifestAdmission.inspect(lish);
			if (fault) unverified.push({ lish, checks, fault });
		}
		const named = unverified.find(item => item.checks.signed) ?? unverified[0];
		if (named && !accepted) throw ManifestAdmission.unverified(named.lish, named.checks, named.fault, this.park(named.lish.id, lishs, resume));
		return resume();
	}

	/**
	 * The user's answer for a waiting manifest: add it, or let it go. `run` wraps the adding in
	 * whatever the caller's own entry points run under. Returns `null` for a refusal.
	 */
	async answer(token: string, accept: boolean, run: (resume: () => Promise<T>) => Promise<T>): Promise<T | null> {
		const entry = [...this.pending].find(([, pending]) => pending.token === token);
		if (!entry) throw new CodedError(ErrorCodes.LISH_CONFIRMATION_EXPIRED, token);
		this.drop(entry[0]);
		return accept ? run(entry[1].resume) : null;
	}

	/** Let every waiting manifest go. */
	clear(): void {
		for (const lishID of [...this.pending.keys()]) this.drop(lishID);
	}

	private static unverified(lish: ILISH, checks: LISHChecks, fault: CodedError, token?: string): CodedError {
		const detail: UnverifiedLISH = { checks, ...(token !== undefined ? { token } : {}), ...(typeof lish.publisher === 'string' ? { publisher: lish.publisher } : {}) };
		return new CodedError(fault.code, JSON.stringify(detail), { cause: fault });
	}

	/** Keep `held`, everything `resume` needs, as the one question open under `lishID`. */
	private park(lishID: string, held: unknown, resume: () => Promise<T>): string {
		this.drop(lishID);
		const weight = heldWeight(held);
		// Oldest first: a client that never answers cannot grow this without bound. A manifest
		// larger than the whole allowance still waits, alone, so the user can answer about it.
		while (this.pending.size > 0 && (this.pending.size >= this.limits.count || this.pendingBytes + weight > this.limits.bytes)) this.drop(this.pending.keys().next().value!);
		const token = randomUUID();
		const timer = setTimeout(() => this.drop(lishID), this.limits.ttlMs);
		timer.unref();
		this.pending.set(lishID, { token, weight, resume, timer });
		this.pendingBytes += weight;
		return token;
	}

	private drop(lishID: string): void {
		const pending = this.pending.get(lishID);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pending.delete(lishID);
		this.pendingBytes -= pending.weight;
	}
}
