import { describe, test, expect } from 'bun:test';
import { hlcTick, hlcMerge, hlcCompare, type HLC } from '../catalog-hlc.ts';

describe('hlcCompare', () => {
	test('higher wallTime wins', () => {
		const a: HLC = { wallTime: 100, logical: 0, nodeID: 'A' };
		const b: HLC = { wallTime: 200, logical: 0, nodeID: 'A' };
		expect(hlcCompare(a, b)).toBeLessThan(0);
		expect(hlcCompare(b, a)).toBeGreaterThan(0);
	});

	test('same wallTime — higher logical wins', () => {
		const a: HLC = { wallTime: 100, logical: 1, nodeID: 'A' };
		const b: HLC = { wallTime: 100, logical: 2, nodeID: 'A' };
		expect(hlcCompare(a, b)).toBeLessThan(0);
	});

	test('same wallTime and logical — nodeID breaks tie', () => {
		const a: HLC = { wallTime: 100, logical: 0, nodeID: 'A' };
		const b: HLC = { wallTime: 100, logical: 0, nodeID: 'B' };
		expect(hlcCompare(a, b)).toBeLessThan(0);
		expect(hlcCompare(b, a)).toBeGreaterThan(0);
	});

	test('identical clocks compare as equal', () => {
		const a: HLC = { wallTime: 100, logical: 0, nodeID: 'A' };
		expect(hlcCompare(a, { ...a })).toBe(0);
	});
});

describe('hlcTick', () => {
	test('advances wallTime when Date.now() > local', () => {
		const local: HLC = { wallTime: 0, logical: 5, nodeID: 'peer1' };
		const result = hlcTick(local);
		expect(result.wallTime).toBeGreaterThan(0);
		expect(result.logical).toBe(0);
		expect(result.nodeID).toBe('peer1');
	});

	test('increments logical when wallTime unchanged', () => {
		const now = Date.now();
		const local: HLC = { wallTime: now + 100_000, logical: 3, nodeID: 'peer1' };
		const result = hlcTick(local);
		expect(result.wallTime).toBe(now + 100_000);
		expect(result.logical).toBe(4);
	});

	test('tick is always strictly greater than input', () => {
		const local: HLC = { wallTime: Date.now(), logical: 0, nodeID: 'peer1' };
		const result = hlcTick(local);
		expect(hlcCompare(result, local)).toBeGreaterThan(0);
	});
});

describe('hlcMerge', () => {
	test('takes max wallTime from local, remote, and now', () => {
		const local: HLC = { wallTime: 100, logical: 0, nodeID: 'A' };
		const remote: HLC = { wallTime: 200, logical: 0, nodeID: 'B' };
		const result = hlcMerge(local, remote);
		expect(result.wallTime).toBeGreaterThanOrEqual(200);
		expect(result.nodeID).toBe('A');
	});

	test('same wallTime — increments logical', () => {
		const futureTime = Date.now() + 100_000;
		const local: HLC = { wallTime: futureTime, logical: 5, nodeID: 'A' };
		const remote: HLC = { wallTime: futureTime, logical: 3, nodeID: 'B' };
		const result = hlcMerge(local, remote);
		expect(result.wallTime).toBe(futureTime);
		expect(result.logical).toBe(6); // max(5,3) + 1
	});

	test('merge result is always > local', () => {
		const local: HLC = { wallTime: Date.now(), logical: 0, nodeID: 'A' };
		const remote: HLC = { wallTime: Date.now() - 1000, logical: 0, nodeID: 'B' };
		const result = hlcMerge(local, remote);
		expect(hlcCompare(result, local)).toBeGreaterThan(0);
	});

	test('preserves local nodeID', () => {
		const local: HLC = { wallTime: 100, logical: 0, nodeID: 'LOCAL' };
		const remote: HLC = { wallTime: 200, logical: 0, nodeID: 'REMOTE' };
		const result = hlcMerge(local, remote);
		expect(result.nodeID).toBe('LOCAL');
	});
});
