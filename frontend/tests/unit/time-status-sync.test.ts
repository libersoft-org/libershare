/**
 * Unit tests for the ordering rules of the system-time settings form
 * (`src/scripts/timeStatusSync.ts`).
 *
 * Both rules govern what happens when several answers about the host's time state are in
 * flight at once — a re-read, a broadcast and the outcome of a write. The module is pure,
 * so it runs under `bun test` without the Svelte runtime.
 */
import { test, expect } from 'bun:test';
import { createStatusGate, writeFailureMessage } from '../../src/scripts/timeStatusSync.ts';

test('a read that nothing overtook is applied', () => {
	const gate = createStatusGate();
	const current = gate.begin();
	expect(current()).toBe(true);
});

/** The reconnect race: the broadcast carries the newer state, the read predates it. */
test('a broadcast adopted mid-read makes that read stale', () => {
	const gate = createStatusGate();
	const current = gate.begin();
	gate.supersede();
	expect(current()).toBe(false);
});

/** Two reconnects in a row: the answers can come back in either order. */
test('an older read stays stale once a newer one has been issued', () => {
	const gate = createStatusGate();
	const first = gate.begin();
	const second = gate.begin();
	expect(first()).toBe(false);
	expect(second()).toBe(true);
	// And the newer one still loses to a broadcast that lands before it is answered.
	gate.supersede();
	expect(second()).toBe(false);
});

test('a write failure keeps its own reason when the reload also failed', () => {
	expect(writeFailureMessage('some settings may already be applied', 'the time could not be read')).toBe('some settings may already be applied: the time could not be read');
});

test('a write failure reads unchanged when the reload succeeded', () => {
	expect(writeFailureMessage('automatic synchronisation is enabled', '')).toBe('automatic synchronisation is enabled');
});
