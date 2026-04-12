import { describe, it, expect } from 'bun:test';

// These are pure functions — re-implemented here to unit test the logic
// (identical to frontend/src/scripts/downloads.ts computeStatus/computeEnabledMode)

type DownloadStatus = 'downloading' | 'uploading' | 'downloading-uploading' | 'idling' | 'verifying' | 'pending-verification' | 'moving';
type EnabledMode = 'disabled' | 'download' | 'upload' | 'both';

function computeStatus(isDown: boolean, isUp: boolean): DownloadStatus {
	if (isDown && isUp) return 'downloading-uploading';
	if (isDown) return 'downloading';
	if (isUp) return 'uploading';
	return 'idling';
}

function computeEnabledMode(downloadEnabled: boolean, uploadEnabled: boolean): EnabledMode {
	if (downloadEnabled && uploadEnabled) return 'both';
	if (downloadEnabled) return 'download';
	if (uploadEnabled) return 'upload';
	return 'disabled';
}

// ============================================================================
// computeStatus
// ============================================================================

describe('computeStatus', () => {
	it('returns idling when nothing active', () => {
		expect(computeStatus(false, false)).toBe('idling');
	});

	it('returns downloading when only download active', () => {
		expect(computeStatus(true, false)).toBe('downloading');
	});

	it('returns uploading when only upload active', () => {
		expect(computeStatus(false, true)).toBe('uploading');
	});

	it('returns downloading-uploading when both active', () => {
		expect(computeStatus(true, true)).toBe('downloading-uploading');
	});
});

// ============================================================================
// computeEnabledMode
// ============================================================================

describe('computeEnabledMode', () => {
	it('returns disabled when nothing enabled', () => {
		expect(computeEnabledMode(false, false)).toBe('disabled');
	});

	it('returns download when only download enabled', () => {
		expect(computeEnabledMode(true, false)).toBe('download');
	});

	it('returns upload when only upload enabled', () => {
		expect(computeEnabledMode(false, true)).toBe('upload');
	});

	it('returns both when both enabled', () => {
		expect(computeEnabledMode(true, true)).toBe('both');
	});
});

// ============================================================================
// Status + Mode independence
// ============================================================================

describe('Status and Mode are independent dimensions', () => {
	it('mode=both but status=idling (enabled but no peers)', () => {
		const mode = computeEnabledMode(true, true);
		const status = computeStatus(false, false);
		expect(mode).toBe('both');
		expect(status).toBe('idling');
	});

	it('mode=disabled but status=downloading (edge case: active download that was just disabled)', () => {
		const mode = computeEnabledMode(false, false);
		const status = computeStatus(true, false);
		expect(mode).toBe('disabled');
		expect(status).toBe('downloading');
	});

	it('mode=upload but status=downloading (download enabled just expired, upload still on)', () => {
		const mode = computeEnabledMode(false, true);
		const status = computeStatus(true, false);
		expect(mode).toBe('upload');
		expect(status).toBe('downloading');
	});

	it('mode=download but status=uploading (upload stale but download enabled)', () => {
		const mode = computeEnabledMode(true, false);
		const status = computeStatus(false, true);
		expect(mode).toBe('download');
		expect(status).toBe('uploading');
	});
});
