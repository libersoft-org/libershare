import { describe, expect, it } from 'bun:test';
import { parseAlsaVolume, parseMacVolume, classifyMixerReadings, createSerializedWriter, createVolumeWatcher, isSinkEvent, type VolumeStatus } from '../../src/system-volume.ts';
import { classifyHresult, readWindowsVolume, writeWindowsVolume } from '../../src/system-volume-windows.ts';

/** Resolve pending microtasks + timers so the serializer can advance. */
const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

describe('parseAlsaVolume', () => {
	it('extracts the percentage from an amixer mixer line', () => {
		const out = '  Front Left: Playback 47104 [72%] [-8.50dB] [on]\n  Front Right: Playback 47104 [72%] [-8.50dB] [on]\n';
		expect(parseAlsaVolume(out)).toBe(72);
	});

	it('extracts the percentage from pactl output', () => {
		expect(parseAlsaVolume('Volume: front-left: 42000 /  64% / -12.00 dB')).toBe(64);
	});

	it('clamps out-of-range values', () => {
		expect(parseAlsaVolume('[150%]')).toBe(100);
	});

	it('returns null when no percentage is present', () => {
		expect(parseAlsaVolume('no volume here')).toBeNull();
	});

	it('returns null for pactl failure on a host with no sink', () => {
		expect(parseAlsaVolume('Failure: No such entity')).toBeNull();
	});
});

describe('parseMacVolume', () => {
	it('parses the bare integer osascript prints', () => {
		expect(parseMacVolume('45\n')).toBe(45);
	});

	it('returns null for non-numeric output', () => {
		expect(parseMacVolume('missing value')).toBeNull();
	});
});

describe('classifyHresult', () => {
	it('maps S_OK to ok', () => {
		expect(classifyHresult(0)).toBe('ok');
	});

	it('maps ELEMENT_NOT_FOUND to no-device, signed or unsigned', () => {
		expect(classifyHresult(0x80070490)).toBe('no-device');
		expect(classifyHresult(0x80070490 | 0)).toBe('no-device'); // as returned by an i32 FFI call
	});

	it('maps any other failure to a transient error', () => {
		expect(classifyHresult(0x80004005 | 0)).toBe('error'); // E_FAIL
		expect(classifyHresult(1)).toBe('error'); // S_FALSE is not a valid mixer answer either
	});
});

// Live CoreAudio FFI checks — real COM calls against the machine's default
// render endpoint. Read-only except for writing back the exact level that was
// just read, so the system volume is never actually changed.
describe.skipIf(process.platform !== 'win32')('windows CoreAudio FFI (live)', () => {
	it('reads the master volume or reports a verified device absence', () => {
		const r = readWindowsVolume();
		expect(r.kind).not.toBe('error'); // a healthy host answers ok or no-device
		if (r.kind === 'ok') {
			expect(r.volume).toBeGreaterThanOrEqual(0);
			expect(r.volume).toBeLessThanOrEqual(100);
		}
	});

	it('writes the current level back and reads the same value again', () => {
		const before = readWindowsVolume();
		if (before.kind !== 'ok' || before.volume === null) return; // no device — nothing to write
		expect(writeWindowsVolume(before.volume)).toEqual({ kind: 'ok', volume: null });
		expect(readWindowsVolume()).toEqual({ kind: 'ok', volume: before.volume });
	});
});

describe('isSinkEvent', () => {
	it('matches sink change events', () => {
		expect(isSinkEvent("Event 'change' on sink #3")).toBe(true);
	});

	it('ignores per-application sink-input events', () => {
		expect(isSinkEvent("Event 'new' on sink-input #87")).toBe(false);
		expect(isSinkEvent("Event 'change' on sink-input #87")).toBe(false);
	});

	it('ignores unrelated events', () => {
		expect(isSinkEvent("Event 'change' on client #5")).toBe(false);
		expect(isSinkEvent("Event 'change' on source #1")).toBe(false);
	});
});

describe('classifyMixerReadings', () => {
	it('returns ok from the first parseable reading (pactl)', () => {
		expect(classifyMixerReadings(['Volume: front-left: 40000 / 55% / -13 dB', null])).toEqual({ kind: 'ok', volume: 55 });
	});

	it('falls back to amixer when pactl is absent', () => {
		expect(classifyMixerReadings([null, 'Mono: Playback 200 [65%] [on]'])).toEqual({ kind: 'ok', volume: 65 });
	});

	it('reports no-device when no binary yields a percentage', () => {
		expect(classifyMixerReadings([null, null])).toEqual({ kind: 'no-device' });
		expect(classifyMixerReadings([null, 'Failure: No such entity'])).toEqual({ kind: 'no-device' });
	});
});

describe('createSerializedWriter', () => {
	it('serializes overlapping writes and ends on the latest value', async () => {
		const started: number[] = [];
		const releases: Array<() => void> = [];
		const write = (v: number) =>
			new Promise<number>(res => {
				started.push(v);
				releases.push(() => res(v));
			});
		const s = createSerializedWriter(write);

		const p1 = s.run(30);
		const p2 = s.run(80);
		await flush();
		expect(started).toEqual([30]); // 80 is queued, not written while 30 runs

		releases[0]!(); // finish write(30)
		await flush();
		expect(started).toEqual([30, 80]); // drain applies the newest queued value

		releases[1]!(); // finish write(80)
		expect(await p2).toBe(80); // coalesced caller gets the final write's result
		expect(await p1).toBe(80); // first (startup-style) caller also resolves to the final written value
		expect(started).toEqual([30, 80]); // exactly two real writes for two requests
	});

	it('coalesces a burst to at most two writes', async () => {
		const started: number[] = [];
		const releases: Array<() => void> = [];
		const write = (v: number) =>
			new Promise<number>(res => {
				started.push(v);
				releases.push(() => res(v));
			});
		const s = createSerializedWriter(write);

		void s.run(10);
		void s.run(20);
		void s.run(30);
		void s.run(40);
		await flush();
		expect(started).toEqual([10]); // only the first started; 20/30 superseded by 40

		releases[0]!();
		await flush();
		releases[1]!();
		await flush();
		expect(started).toEqual([10, 40]); // intermediates skipped, ends on the latest
	});

	it('recovers after a write failure instead of staying locked', async () => {
		let fail = true;
		const written: number[] = [];
		const s = createSerializedWriter(async (v: number) => {
			if (fail) throw new Error('boom');
			written.push(v);
			return v;
		});

		await expect(s.run(10)).rejects.toThrow('boom');
		await flush();
		fail = false;
		expect(await s.run(20)).toBe(20); // a stuck `running` flag would queue this forever
		expect(written).toEqual([20]);
	});

	it('rejects a queued caller when the write serving it fails', async () => {
		const releases: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
		const s = createSerializedWriter(
			(v: number) =>
				new Promise<number>((resolve, reject) => {
					releases.push({ resolve: () => resolve(v), reject });
				})
		);

		// Attach rejection handlers up front so the runner never sees an unhandled rejection.
		const p1 = s.run(10).catch((e: Error) => `rejected:${e.message}`);
		const p2 = s.run(20).catch((e: Error) => `rejected:${e.message}`); // queued behind 10
		await flush();
		releases[0]!.reject(new Error('boom')); // the running write fails
		expect(await p1).toBe('rejected:boom');
		expect(await p2).toBe('rejected:boom'); // the queued caller must not hang

		const p3 = s.run(30); // still usable afterwards
		await flush();
		releases[1]!.resolve();
		expect(await p3).toBe(30);
	});
});

describe('createVolumeWatcher', () => {
	function setup(statuses: Array<VolumeStatus | null>, isBusy: () => boolean = () => false) {
		let i = 0;
		const broadcasts: VolumeStatus[] = [];
		const persisted: number[] = [];
		const watcher = createVolumeWatcher({
			getStatus: async () => statuses[Math.min(i++, statuses.length - 1)]!,
			broadcast: s => broadcasts.push(s),
			persist: v => persisted.push(v),
			isBusy,
		});
		return { watcher, broadcasts, persisted };
	}

	it('ingests an instant push, broadcasting and persisting on change', () => {
		const { watcher, broadcasts, persisted } = setup([]);
		watcher.ingest({ volume: 55, available: true });
		expect(broadcasts).toEqual([{ volume: 55, available: true }]);
		expect(persisted).toEqual([55]);
	});

	it('drops an ingested push while a mixer write is active or settling', () => {
		let busy = true;
		const { watcher, broadcasts, persisted } = setup([], () => busy);
		watcher.ingest({ volume: 20, available: true }); // intermediate level mid-write
		expect(broadcasts).toEqual([]);
		expect(persisted).toEqual([]);
		busy = false;
		watcher.ingest({ volume: 20, available: true });
		expect(broadcasts).toEqual([{ volume: 20, available: true }]);
	});

	it('suppresses an ingested push that echoes our own write', () => {
		const { watcher, broadcasts } = setup([]);
		watcher.remember({ volume: 55, available: true });
		watcher.ingest({ volume: 55, available: true });
		expect(broadcasts).toEqual([]);
	});

	it('exposes last known availability to gate the push monitor', () => {
		const { watcher } = setup([]);
		expect(watcher.available()).toBe(true); // optimistic before the first reading
		watcher.ingest({ volume: 0, available: false });
		expect(watcher.available()).toBe(false);
		watcher.ingest({ volume: 30, available: true });
		expect(watcher.available()).toBe(true);
	});

	it('broadcasts and persists when the level changes', async () => {
		const { watcher, broadcasts, persisted } = setup([
			{ volume: 40, available: true },
			{ volume: 70, available: true },
		]);
		await watcher.poll();
		await watcher.poll();
		expect(broadcasts).toEqual([
			{ volume: 40, available: true },
			{ volume: 70, available: true },
		]);
		expect(persisted).toEqual([40, 70]);
	});

	it('stays silent when the status is unchanged', async () => {
		const { watcher, broadcasts } = setup([
			{ volume: 40, available: true },
			{ volume: 40, available: true },
		]);
		await watcher.poll();
		await watcher.poll();
		expect(broadcasts).toEqual([{ volume: 40, available: true }]);
	});

	it('does not echo a value we just wrote', async () => {
		const { watcher, broadcasts, persisted } = setup([{ volume: 55, available: true }]);
		watcher.remember({ volume: 55, available: true });
		await watcher.poll();
		expect(broadcasts).toEqual([]);
		expect(persisted).toEqual([]);
	});

	it('broadcasts when availability flips', async () => {
		const { watcher, broadcasts } = setup([
			{ volume: 60, available: true },
			{ volume: null, available: false },
		]);
		await watcher.poll();
		await watcher.poll();
		expect(broadcasts).toEqual([
			{ volume: 60, available: true },
			{ volume: null, available: false },
		]);
	});

	it('keeps availability across a transient read error', async () => {
		// ok(50) → transient(null) → ok(50): no availability flip, one broadcast.
		const { watcher, broadcasts } = setup([{ volume: 50, available: true }, null, { volume: 50, available: true }]);
		await watcher.poll(); // ok → broadcast {50,true}
		await watcher.poll(); // transient → skipped, last kept
		await watcher.poll(); // ok, equals last → no broadcast
		expect(broadcasts).toEqual([{ volume: 50, available: true }]);
	});

	it('does not broadcast unavailable on a transient error as the first read', async () => {
		const { watcher, broadcasts, persisted } = setup([null]);
		await watcher.poll();
		expect(broadcasts).toEqual([]);
		expect(persisted).toEqual([]);
	});

	it('skips while a write is active, then resumes for genuine changes', async () => {
		let busy = true;
		const { watcher, broadcasts, persisted } = setup(
			[
				{ volume: 80, available: true }, // the value we wrote (read once settled)
				{ volume: 40, available: true }, // a later genuine external change
			],
			() => busy
		);

		await watcher.poll(); // write active → skipped, nothing read
		expect(broadcasts).toEqual([]);
		expect(persisted).toEqual([]);

		watcher.remember({ volume: 80, available: true }); // our own write settled
		busy = false;
		await watcher.poll(); // reads 80 == remembered → no echo
		expect(broadcasts).toEqual([]);
		expect(persisted).toEqual([]);

		await watcher.poll(); // reads 40 → genuine external change → event + persist
		expect(broadcasts).toEqual([{ volume: 40, available: true }]);
		expect(persisted).toEqual([40]);
	});

	it('coalesces a reentrant poll into a single trailing re-read', async () => {
		const resolvers: Array<(s: VolumeStatus | null) => void> = [];
		let reads = 0;
		const broadcasts: VolumeStatus[] = [];
		const watcher = createVolumeWatcher({
			getStatus: () => {
				reads++;
				return new Promise<VolumeStatus | null>(res => resolvers.push(res));
			},
			broadcast: s => broadcasts.push(s),
			persist: () => {},
			isBusy: () => false,
		});

		const p1 = watcher.poll(); // read #1 in flight
		const p2 = watcher.poll(); // reentrant tick → queues ONE trailing re-read, no immediate 2nd read
		expect(reads).toBe(1);

		resolvers[0]!({ volume: 30, available: true }); // read #1 resolves → trailing read #2 starts
		await new Promise(r => setTimeout(r, 0));
		expect(reads).toBe(2); // exactly one trailing re-read, not a per-call read

		resolvers[1]!({ volume: 30, available: true }); // read #2: same value → no second broadcast
		await Promise.all([p1, p2]);
		expect(reads).toBe(2);
		expect(broadcasts).toEqual([{ volume: 30, available: true }]);
	});

	it('re-reads once more when a change is signalled mid-read', async () => {
		// A monitor push (or another poll) during an in-flight read must not be lost:
		// the trailing re-read picks up the newer level.
		const resolvers: Array<(s: VolumeStatus | null) => void> = [];
		const broadcasts: VolumeStatus[] = [];
		const watcher = createVolumeWatcher({
			getStatus: () => new Promise<VolumeStatus | null>(res => resolvers.push(res)),
			broadcast: s => broadcasts.push(s),
			persist: () => {},
			isBusy: () => false,
		});

		const p1 = watcher.poll(); // read #1 in flight
		void watcher.poll(); // signals a pending trailing re-read
		resolvers[0]!({ volume: 30, available: true }); // read #1 → broadcast 30, trailing read starts
		await new Promise(r => setTimeout(r, 0));
		resolvers[1]!({ volume: 55, available: true }); // trailing read sees a newer level
		await p1;
		expect(broadcasts).toEqual([
			{ volume: 30, available: true },
			{ volume: 55, available: true },
		]);
	});
});
