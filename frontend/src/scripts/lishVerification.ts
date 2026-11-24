/**
 * What the UI says about a LISH that is not verified: the question before adding one and the
 * rows of the detail. Pure module, no Svelte imports, so the wording rules are unit-testable.
 */
import { isDerivedLISHID, isVerifiedLISH, unverifiedLISHFromError, type LISHChecks, type UnverifiedLISH, type UnverifiedLISHCode } from '@shared';

/** A LISH the backend holds until the user answers, as the import and add screens queue it. */
export interface UnverifiedOffer extends UnverifiedLISH {
	code: UnverifiedLISHCode;
	id: string;
	name: string;
}

/** The offer inside an error from an import or add call; `null` when the error is something else. */
export function unverifiedOffer(error: unknown, lish: { id: string; name?: string | undefined }): UnverifiedOffer | null {
	const unverified = unverifiedLISHFromError(error);
	return unverified ? { ...unverified, id: lish.id, name: lish.name || lish.id } : null;
}

/**
 * Translation key of the question for one unverified LISH. An unsigned LISH under a derived ID
 * gets its own wording: such an ID is only ever made by signing, so the signature was taken off.
 */
export function unverifiedQuestionKey(offer: Pick<UnverifiedOffer, 'code' | 'id'>): string {
	if (offer.code === 'LISH_INVALID_SIGNATURE') return 'lish.unverified.askInvalidSignature';
	if (offer.code === 'LISH_ID_MISMATCH') return 'lish.unverified.askIDMismatch';
	return isDerivedLISHID(offer.id) ? 'lish.unverified.askSignatureRemoved' : 'lish.unverified.askUnsigned';
}

/** One row of the checks shown in a LISH detail. */
export interface CheckRow {
	labelKey: string;
	passed: boolean;
}

/**
 * The rows a detail shows under its "verified / not verified" line. An unsigned LISH has one row:
 * with no signature there is nothing else to judge.
 */
export function checkRows(checks: LISHChecks): CheckRow[] {
	const rows: CheckRow[] = [{ labelKey: 'lish.checks.signed', passed: checks.signed }];
	if (!checks.signed) return rows;
	rows.push({ labelKey: 'lish.checks.signatureValid', passed: checks.signatureValid === true });
	rows.push({ labelKey: 'lish.checks.idMatchesPublisher', passed: checks.idMatchesPublisher === true });
	return rows;
}

/** Translation key of the one-word state of a LISH. */
export function verificationKey(checks: LISHChecks | undefined): string {
	return isVerifiedLISH(checks) ? 'lish.checks.verified' : 'lish.checks.unverified';
}
