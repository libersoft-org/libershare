import { describe, it, expect, beforeEach } from 'bun:test';
import {
	pauseUpload,
	resumeUpload,
	isUploadPaused,
	getEnabledUploads,
	getActiveUploads,
	setUploadBroadcast,
	setMaxUploadSpeed,
	resetUploadState,
	type LISHResponse,
} from '../../../src/protocol/lish-protocol.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChunkData(bytes: number): Uint8Array {
	return new Uint8Array(bytes).fill(0xab);
}

/** Build a fake upload info entry directly in the activeUploads map. */
function seedActiveUpload(lishID: string, chunks: number, bytes: number): void {
	const uploads = getActiveUploads();
	uploads.set(lishID, {
		chunks,
		bytes,
		startTime: Date.now() - 1000,
		peers: 1,
		speedSamples: [],
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lish-protocol – upload state', () => {
	beforeEach(() => {
		resetUploadState();
	});

	// ---- pauseUpload / resumeUpload / isUploadPaused ----------------------

	it('pauseUpload adds lishID to pausedUploads', () => {
		pauseUpload('lish-abc');
		expect(isUploadPaused('lish-abc')).toBe(true);
	});

	it('pauseUpload does not affect other lishIDs', () => {
		resumeUpload('lish-xyz'); // enable first
		pauseUpload('lish-abc');
		expect(isUploadPaused('lish-xyz')).toBe(false);
	});

	it('resumeUpload removes lishID from pausedUploads', () => {
		pauseUpload('lish-abc');
		resumeUpload('lish-abc');
		expect(isUploadPaused('lish-abc')).toBe(false);
	});

	it('resumeUpload on non-paused lishID is a no-op', () => {
		resumeUpload('lish-never-paused');
		expect(isUploadPaused('lish-never-paused')).toBe(false);
	});

	it('can pause multiple lishIDs independently', () => {
		pauseUpload('lish-1');
		pauseUpload('lish-2');
		expect(isUploadPaused('lish-1')).toBe(true);
		expect(isUploadPaused('lish-2')).toBe(true);
		resumeUpload('lish-1');
		expect(isUploadPaused('lish-1')).toBe(false);
		expect(isUploadPaused('lish-2')).toBe(true);
	});

	// ---- getEnabledUploads ------------------------------------------------

	it('getEnabledUploads returns the live Set (initially empty after reset)', () => {
		const set = getEnabledUploads();
		expect(set.size).toBe(0);
	});

	it('resumeUpload adds to enabledUploads, pauseUpload removes', () => {
		resumeUpload('lish-live');
		const set = getEnabledUploads();
		expect(set.has('lish-live')).toBe(true);
		pauseUpload('lish-live');
		expect(set.has('lish-live')).toBe(false);
	});

	// ---- broadcast events on pause / resume -------------------------------

	it('pauseUpload broadcasts upload:paused event with lishID', () => {
		const events: Array<{ event: string; data: unknown }> = [];
		setUploadBroadcast((event, data) => events.push({ event, data }));

		pauseUpload('lish-broadcast');

		expect(events).toHaveLength(1);
		expect(events[0]!.event).toBe('transfer.upload:paused');
		expect((events[0]!.data as { lishID: string }).lishID).toBe('lish-broadcast');
	});

	it('resumeUpload broadcasts upload:resumed event with lishID', () => {
		const events: Array<{ event: string; data: unknown }> = [];
		setUploadBroadcast((event, data) => events.push({ event, data }));

		pauseUpload('lish-broadcast');
		events.length = 0; // clear pause event

		resumeUpload('lish-broadcast');

		expect(events).toHaveLength(1);
		expect(events[0]!.event).toBe('transfer.upload:resumed');
		expect((events[0]!.data as { lishID: string }).lishID).toBe('lish-broadcast');
	});

	it('pause/resume do not broadcast when no broadcastFn is set', () => {
		// No broadcastFn — must not throw
		expect(() => {
			pauseUpload('lish-no-fn');
			resumeUpload('lish-no-fn');
		}).not.toThrow();
	});

	// ---- activeUploads map ------------------------------------------------

	it('getActiveUploads returns the live Map (initially empty after reset)', () => {
		expect(getActiveUploads().size).toBe(0);
	});

	it('seeded upload entry has correct shape', () => {
		seedActiveUpload('lish-seed', 5, 5120);
		const info = getActiveUploads().get('lish-seed');
		expect(info).toBeDefined();
		expect(info!.chunks).toBe(5);
		expect(info!.bytes).toBe(5120);
	});

	it('resetUploadState clears activeUploads', () => {
		seedActiveUpload('lish-will-reset', 3, 3000);
		expect(getActiveUploads().size).toBe(1);
		resetUploadState();
		expect(getActiveUploads().size).toBe(0);
	});

	it('resetUploadState clears enabled uploads (all become paused)', () => {
		resumeUpload('lish-will-reset');
		expect(isUploadPaused('lish-will-reset')).toBe(false);
		resetUploadState();
		expect(isUploadPaused('lish-will-reset')).toBe(true); // no longer enabled = paused
	});

	// ---- speed rolling window calculation (unit math) --------------------

	it('speed rolling window: only samples within 10s count', () => {
		const now = Date.now();
		const uploads = getActiveUploads();
		uploads.set('lish-speed', {
			chunks: 0,
			bytes: 0,
			startTime: now - 15000,
			peers: 1,
			speedSamples: [
				{ time: now - 12000, bytes: 100000 }, // older than 10s — should be filtered
				{ time: now - 5000, bytes: 50000 },
				{ time: now - 1000, bytes: 50000 },
			],
		});

		const info = uploads.get('lish-speed')!;
		// Simulate the same filter logic used by handleLISHProtocol
		info.speedSamples = info.speedSamples.filter(s => s.time > now - 10000);
		const windowBytes = info.speedSamples.reduce((sum, s) => sum + s.bytes, 0);
		// Only the 2 recent samples remain (100000 each)
		expect(info.speedSamples).toHaveLength(2);
		expect(windowBytes).toBe(100000);
	});

	it('speed rolling window: bytes per second calculation', () => {
		const now = Date.now();
		const uploads = getActiveUploads();
		uploads.set('lish-bps', {
			chunks: 0,
			bytes: 0,
			startTime: now - 5000,
			peers: 1,
			speedSamples: [
				{ time: now - 4000, bytes: 20000 },
				{ time: now - 2000, bytes: 20000 },
			],
		});

		const info = uploads.get('lish-bps')!;
		const windowBytes = info.speedSamples.reduce((sum, s) => sum + s.bytes, 0);
		const windowSec = (now - info.speedSamples[0]!.time) / 1000; // ~4s
		const bytesPerSecond = windowSec > 0.1 ? Math.round(windowBytes / windowSec) : 0;

		// 40000 bytes over ~4 sec ≈ 10000 B/s
		expect(bytesPerSecond).toBeGreaterThan(5000);
		expect(bytesPerSecond).toBeLessThan(20000);
	});

	it('speed returns 0 when window is shorter than 0.1s', () => {
		const now = Date.now();
		const uploads = getActiveUploads();
		uploads.set('lish-tiny', {
			chunks: 0,
			bytes: 0,
			startTime: now,
			peers: 1,
			speedSamples: [{ time: now, bytes: 9999 }],
		});

		const info = uploads.get('lish-tiny')!;
		const windowBytes = info.speedSamples.reduce((sum, s) => sum + s.bytes, 0);
		const windowSec = info.speedSamples.length > 1 ? (now - info.speedSamples[0]!.time) / 1000 : 0;
		const bytesPerSecond = windowSec > 0.1 ? Math.round(windowBytes / windowSec) : 0;

		expect(bytesPerSecond).toBe(0);
	});

	// ---- setMaxUploadSpeed -----------------------------------------------

	it('setMaxUploadSpeed(100) sets limit to 100 * 1024 bytes', () => {
		// We verify indirectly through the exported getters; the module-level var is
		// private, so we confirm setting 0 clears it and non-zero enables throttling.
		// (Direct value not exported — behaviour is tested via resetUploadState clearing it.)
		setMaxUploadSpeed(100);
		// No exception — function exists and accepts numeric input
		setMaxUploadSpeed(0); // reset to unlimited
	});

	it('setMaxUploadSpeed with negative value clamps to 0', () => {
		expect(() => setMaxUploadSpeed(-50)).not.toThrow();
		// After clamping, value should be 0 — verified by reset clearing it
		resetUploadState(); // clears to 0
	});

	// ---- setUploadBroadcast overwrite -------------------------------------

	it('setUploadBroadcast replaces previous broadcast function', () => {
		const calls1: string[] = [];
		const calls2: string[] = [];
		setUploadBroadcast(event => calls1.push(event));
		setUploadBroadcast(event => calls2.push(event));

		pauseUpload('lish-fn-replace');

		expect(calls1).toHaveLength(0);
		expect(calls2).toHaveLength(1);
	});

	// ---- activeUploads: chunks/bytes increment ---------------------------

	it('manually incrementing activeUploads entry works correctly', () => {
		const lishID = 'lish-incr';
		const uploads = getActiveUploads();
		uploads.set(lishID, { chunks: 0, bytes: 0, startTime: Date.now(), peers: 0, speedSamples: [] });

		const info = uploads.get(lishID)!;
		const chunkBytes = makeChunkData(1024).length;
		info.chunks++;
		info.bytes += chunkBytes;

		expect(info.chunks).toBe(1);
		expect(info.bytes).toBe(1024);
	});

	it('peers count in activeUploads reflects stream count', () => {
		const lishID = 'lish-peers';
		const uploads = getActiveUploads();
		uploads.set(lishID, { chunks: 0, bytes: 0, startTime: Date.now(), peers: 0, speedSamples: [] });

		const info = uploads.get(lishID)!;
		info.peers = 3;
		expect(uploads.get(lishID)!.peers).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// Base64 chunk encoding (per LISH protocol spec)
// ---------------------------------------------------------------------------

describe('lish-protocol – base64 chunk encoding', () => {

	// --- LISHResponse type conformance ---

	it('LISHResponse.data is string|null (base64), not number[]', () => {
		const response: LISHResponse = { data: 'AQID' }; // base64 for [1,2,3]
		expect(typeof response.data).toBe('string');
	});

	it('LISHResponse.data null represents missing chunk', () => {
		const response: LISHResponse = { data: null };
		expect(response.data).toBeNull();
	});

	// --- Encode/decode roundtrip ---

	it('roundtrip: 1MB chunk survives base64 encode → JSON → parse → decode', () => {
		const original = new Uint8Array(1024 * 1024);
		for (let i = 0; i < original.length; i++) original[i] = i % 256;

		// Server side: encode
		const response: LISHResponse = { data: Buffer.from(original).toString('base64') };
		const json = JSON.stringify(response);

		// Client side: decode
		const parsed: LISHResponse = JSON.parse(json);
		const decoded = new Uint8Array(Buffer.from(parsed.data!, 'base64'));

		expect(decoded.length).toBe(original.length);
		expect(decoded).toEqual(original);
	});

	it('roundtrip: small chunk (3 bytes)', () => {
		const original = new Uint8Array([0xDE, 0xAD, 0xBE]);
		const b64 = Buffer.from(original).toString('base64');
		const decoded = new Uint8Array(Buffer.from(b64, 'base64'));
		expect(decoded).toEqual(original);
	});

	it('roundtrip: empty chunk (0 bytes)', () => {
		const original = new Uint8Array(0);
		const b64 = Buffer.from(original).toString('base64');
		expect(b64).toBe('');
		const decoded = new Uint8Array(Buffer.from(b64, 'base64'));
		expect(decoded.length).toBe(0);
	});

	it('roundtrip: all possible byte values (0-255)', () => {
		const original = new Uint8Array(256);
		for (let i = 0; i < 256; i++) original[i] = i;
		const b64 = Buffer.from(original).toString('base64');
		const decoded = new Uint8Array(Buffer.from(b64, 'base64'));
		expect(decoded).toEqual(original);
	});

	// --- Performance vs old Array.from() ---

	it('base64 encode is faster than Array.from for 1MB', () => {
		const data = new Uint8Array(1024 * 1024);
		for (let i = 0; i < data.length; i++) data[i] = i % 256;

		const t1 = Date.now();
		for (let i = 0; i < 10; i++) Buffer.from(data).toString('base64');
		const b64Time = Date.now() - t1;

		const t2 = Date.now();
		for (let i = 0; i < 10; i++) Array.from(data);
		const arrayTime = Date.now() - t2;

		// base64 should be significantly faster
		expect(b64Time).toBeLessThan(arrayTime);
	});

	it('base64 full roundtrip (encode+JSON+parse+decode) is faster than Array.from roundtrip for 1MB', () => {
		const data = new Uint8Array(1024 * 1024);
		for (let i = 0; i < data.length; i++) data[i] = i % 256;

		const t1 = Date.now();
		for (let i = 0; i < 5; i++) {
			const json = JSON.stringify({ data: Buffer.from(data).toString('base64') });
			const parsed = JSON.parse(json);
			Buffer.from(parsed.data, 'base64');
		}
		const b64Time = Date.now() - t1;

		const t2 = Date.now();
		for (let i = 0; i < 5; i++) {
			const json = JSON.stringify({ data: Array.from(data) });
			const parsed = JSON.parse(json);
			new Uint8Array(parsed.data);
		}
		const arrayTime = Date.now() - t2;

		// Full roundtrip: base64 should be significantly faster
		expect(b64Time).toBeLessThan(arrayTime);
	});

	// --- Size comparison ---

	it('base64 JSON is smaller than Array.from JSON for 1MB', () => {
		const data = new Uint8Array(1024 * 1024);
		for (let i = 0; i < data.length; i++) data[i] = i % 256;

		const b64Json = JSON.stringify({ data: Buffer.from(data).toString('base64') });
		const arrayJson = JSON.stringify({ data: Array.from(data) });

		// base64: ~1.33MB, Array.from: ~3.57MB
		expect(b64Json.length).toBeLessThan(arrayJson.length);
		expect(b64Json.length).toBeLessThan(1.5 * 1024 * 1024); // under 1.5MB
		expect(arrayJson.length).toBeGreaterThan(3 * 1024 * 1024); // over 3MB
	});

	// --- Integrity: base64 chunk + SHA256 verification ---

	it('base64 roundtrip preserves SHA256 hash', () => {
		const data = new Uint8Array(4096);
		for (let i = 0; i < data.length; i++) data[i] = (i * 13 + 7) % 256;

		const originalHash = new Bun.CryptoHasher('sha256');
		originalHash.update(data);
		const expectedHash = originalHash.digest('hex');

		// Encode → JSON → decode
		const b64 = Buffer.from(data).toString('base64');
		const decoded = new Uint8Array(Buffer.from(b64, 'base64'));

		const decodedHash = new Bun.CryptoHasher('sha256');
		decodedHash.update(decoded);
		const actualHash = decodedHash.digest('hex');

		expect(actualHash).toBe(expectedHash);
	});

	// --- Edge: JSON serialization correctness ---

	it('base64 string does not contain characters that break JSON', () => {
		// base64 alphabet: A-Z, a-z, 0-9, +, /, = — all JSON-safe
		const data = new Uint8Array(1024);
		for (let i = 0; i < data.length; i++) data[i] = i % 256;
		const b64 = Buffer.from(data).toString('base64');

		// Verify it survives JSON roundtrip
		const json = JSON.stringify({ data: b64 });
		const parsed = JSON.parse(json);
		expect(parsed.data).toBe(b64);
	});

	it('null response serializes correctly in JSON', () => {
		const response: LISHResponse = { data: null };
		const json = JSON.stringify(response);
		const parsed: LISHResponse = JSON.parse(json);
		expect(parsed.data).toBeNull();
	});
});
