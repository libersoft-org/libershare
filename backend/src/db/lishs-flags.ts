import { type Database } from 'bun:sqlite';
import { type LISHid } from '@shared';

/** Cumulative uploaded/downloaded byte counters for a LISH. */
export interface TransferStats {
	uploadedBytes: number;
	downloadedBytes: number;
}

// -- Upload/download enabled persistence --

/** Persists the upload-enabled flag for a LISH. */
export function setUploadEnabled(db: Database, lishID: LISHid, enabled: boolean): void {
	db.run('UPDATE lishs SET upload_enabled = ? WHERE lish_id = ?', [enabled ? 1 : 0, lishID]);
}

/** Persists the download-enabled flag for a LISH. */
export function setDownloadEnabled(db: Database, lishID: LISHid, enabled: boolean): void {
	db.run('UPDATE lishs SET download_enabled = ? WHERE lish_id = ?', [enabled ? 1 : 0, lishID]);
}

/** Returns the set of LISHids that currently have upload enabled. */
export function getUploadEnabledLishs(db: Database): Set<string> {
	return new Set(
		db
			.query<{ lish_id: string }, []>('SELECT lish_id FROM lishs WHERE upload_enabled = TRUE')
			.all()
			.map(r => r.lish_id)
	);
}

/** Returns the set of LISHids that currently have download enabled. */
export function getDownloadEnabledLishs(db: Database): Set<string> {
	return new Set(
		db
			.query<{ lish_id: string }, []>('SELECT lish_id FROM lishs WHERE download_enabled = TRUE')
			.all()
			.map(r => r.lish_id)
	);
}

/** Persists the protected lishnets a LISH is restricted to; an empty list makes it public (NULL). */
export function setLISHScope(db: Database, lishID: LISHid, networkIDs: string[]): void {
	db.run('UPDATE lishs SET scope = ? WHERE lish_id = ?', [networkIDs.length > 0 ? JSON.stringify(networkIDs) : null, lishID]);
}

/** The stored scope column as a list; [] for NULL. A value that does not parse fails closed to a scope no node has. */
export function parseLISHScope(raw: string | null): string[] {
	if (raw === null) return [];
	let ids: unknown;
	try {
		ids = JSON.parse(raw);
	} catch {}
	const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
	// A damaged scope must not turn a protected LISH public.
	return list.length > 0 ? list : [''];
}

/** Every LISH restricted to protected lishnets, with those lishnets. */
export function getLISHScopes(db: Database): Map<string, string[]> {
	const scopes = new Map<string, string[]>();
	for (const row of db.query<{ lish_id: string; scope: string }, []>('SELECT lish_id, scope FROM lishs WHERE scope IS NOT NULL').all()) scopes.set(row.lish_id, parseLISHScope(row.scope));
	return scopes;
}

/** Persists whether a LISH has a verification that has not run to its end yet. */
export function setVerifyPending(db: Database, lishID: LISHid, pending: boolean): void {
	db.run('UPDATE lishs SET verify_pending = ? WHERE lish_id = ?', [pending ? 1 : 0, lishID]);
}

/** Whether a LISH still owes a verification that has not run to its end. */
export function isVerifyPending(db: Database, lishID: LISHid): boolean {
	return db.query<{ verify_pending: number }, [string]>('SELECT verify_pending FROM lishs WHERE lish_id = ?').get(lishID)?.verify_pending === 1;
}

/** Forgets every pending verification, as when the user stops them all. */
export function clearAllVerifyPending(db: Database): void {
	db.run('UPDATE lishs SET verify_pending = FALSE WHERE verify_pending = TRUE');
}

/** Returns the LISHids whose verification was interrupted (stop, crash) before it finished. */
export function getVerifyPendingLishs(db: Database): string[] {
	return db
		.query<{ lish_id: string }, []>('SELECT lish_id FROM lishs WHERE verify_pending = TRUE ORDER BY id')
		.all()
		.map(r => r.lish_id);
}

// -- Transfer stats persistence --

/** Adds to the cumulative uploaded-bytes counter for a LISH. */
export function incrementUploadedBytes(db: Database, lishID: LISHid, bytes: number): void {
	db.run('UPDATE lishs SET total_uploaded_bytes = total_uploaded_bytes + ? WHERE lish_id = ?', [bytes, lishID]);
}

/** Adds to the cumulative downloaded-bytes counter for a LISH. */
export function incrementDownloadedBytes(db: Database, lishID: LISHid, bytes: number): void {
	db.run('UPDATE lishs SET total_downloaded_bytes = total_downloaded_bytes + ? WHERE lish_id = ?', [bytes, lishID]);
}

/** Reads the cumulative uploaded/downloaded byte counters for a LISH (0 when absent). */
export function getTransferStats(db: Database, lishID: LISHid): TransferStats {
	const row = db.query<{ total_uploaded_bytes: number; total_downloaded_bytes: number }, [string]>('SELECT total_uploaded_bytes, total_downloaded_bytes FROM lishs WHERE lish_id = ?').get(lishID);
	return { uploadedBytes: row?.total_uploaded_bytes ?? 0, downloadedBytes: row?.total_downloaded_bytes ?? 0 };
}

// -- Error state persistence --

/** Records an error code (and optional detail) against a LISH. */
export function setLISHError(db: Database, lishID: LISHid, errorCode: string, errorDetail?: string): void {
	db.run('UPDATE lishs SET error_code = ?, error_detail = ? WHERE lish_id = ?', [errorCode, errorDetail ?? null, lishID]);
}

/** Clears any recorded error code/detail for a LISH. */
export function clearLISHError(db: Database, lishID: LISHid): void {
	db.run('UPDATE lishs SET error_code = NULL, error_detail = NULL WHERE lish_id = ?', [lishID]);
}
