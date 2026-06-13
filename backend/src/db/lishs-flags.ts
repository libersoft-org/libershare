import { type Database } from 'bun:sqlite';
import { type LISHid } from '@shared';

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
export function getTransferStats(db: Database, lishID: LISHid): { uploadedBytes: number; downloadedBytes: number } {
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
