/**
 * Unit tests for the ordering rules of the system-time settings form
 * (`src/scripts/timeStatusSync.ts`).
 *
 * The rules govern what happens when several answers about the host's time state are in
 * flight at once — a re-read, a broadcast and the outcome of a write. The module is pure,
 * so it runs under `bun test` without the Svelte runtime.
 */
import { test, expect } from 'bun:test';
import { writeFailureMessage } from '../../src/scripts/timeStatusSync.ts';

test('a write failure keeps its own reason when the reload also failed', () => {
	expect(writeFailureMessage('some settings may already be applied', 'the time could not be read')).toBe('some settings may already be applied: the time could not be read');
});

test('a write failure reads unchanged when the reload succeeded', () => {
	expect(writeFailureMessage('automatic synchronisation is enabled', '')).toBe('automatic synchronisation is enabled');
});
