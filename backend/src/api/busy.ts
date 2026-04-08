/**
 * Shared busy state for LISHs that are moving or verifying.
 * While busy, upload and download MUST be blocked.
 */

export type BusyReason = 'moving' | 'verifying' | 'deleting';

const busyLishs = new Map<string, BusyReason>();

export function setBusy(lishID: string, reason: BusyReason): void {
	busyLishs.set(lishID, reason);
}

export function clearBusy(lishID: string): void {
	busyLishs.delete(lishID);
}

export function isBusy(lishID: string): boolean {
	return busyLishs.has(lishID);
}

export function getBusyReason(lishID: string): BusyReason | undefined {
	return busyLishs.get(lishID);
}

export function getBusyLishs(): Map<string, BusyReason> {
	return busyLishs;
}
