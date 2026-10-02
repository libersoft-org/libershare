import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeMutationJournal, NativeMutationBusy, type NativeMutationRecord } from '../../src/native/mutation-journal.ts';

function record(): NativeMutationRecord {
	return { version: 1, operationId: crypto.randomUUID(), requestHash: 'a'.repeat(64), domain: 'network', operation: 'ipv4', since: 123, phase: 'pending', bootId: 'boot-a', executor: { pid: 101, started: 'instance-a' }, executorReturned: false, endRule: { kind: 'boot' }, recoveryData: { address: '192.0.2.10' } };
}

async function fixture(run: (journal: NativeMutationJournal, directory: string) => void | Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), 'native-journal-'));
	const journal = new NativeMutationJournal(directory);
	try {
		await run(journal, directory);
	} finally {
		journal.close();
		await rm(directory, { recursive: true, force: true });
	}
}

test('a second backend sees the pending operation and cannot replace its owner', async () => {
	await fixture((journal, directory) => {
		const initial = record();
		journal.begin(initial);
		const reopened = new NativeMutationJournal(directory);
		try {
			expect(reopened.read('network')).toEqual({ record: initial, revision: 0 });
			expect(() => reopened.begin(record())).toThrow(NativeMutationBusy);
			expect(reopened.read('network')!.record.operationId).toBe(initial.operationId);
		} finally {
			reopened.close();
		}
	});
});

test('an outstanding write cannot be acknowledged or cleared', async () => {
	await fixture(journal => {
		const initial = record();
		journal.begin(initial);
		expect(() => journal.finish('network', initial.operationId, 0)).toThrow(NativeMutationBusy);
		expect(() => journal.finish('network', initial.operationId, 0, true)).toThrow(NativeMutationBusy);
		expect(journal.read('network')!.record.phase).toBe('pending');
	});
});

test('stale completion cannot clear another phase or a newer operation', async () => {
	await fixture(journal => {
		const initial = record();
		journal.begin(initial);
		const revision = journal.update({ ...initial, phase: 'settling' }, 0);
		expect(() => journal.update({ ...initial, phase: 'interrupted' }, 0)).toThrow('ownership changed');
		expect(() => journal.finish('network', initial.operationId, 0)).toThrow('ownership changed');
		journal.finish('network', initial.operationId, revision);
		const next = record();
		journal.begin(next);
		expect(() => journal.finish('network', initial.operationId, revision)).toThrow('ownership changed');
		expect(journal.read('network')!.record.operationId).toBe(next.operationId);
	});
});

test('only an interrupted operation can be explicitly acknowledged', async () => {
	await fixture(journal => {
		const initial = record();
		journal.begin(initial);
		const settling = journal.update({ ...initial, phase: 'settling' }, 0);
		expect(() => journal.finish('network', initial.operationId, settling, true)).toThrow(NativeMutationBusy);
		const interrupted = journal.update({ ...initial, phase: 'interrupted' }, settling);
		expect(() => journal.finish('network', initial.operationId, interrupted)).toThrow(NativeMutationBusy);
		journal.finish('network', initial.operationId, interrupted, true);
		expect(journal.read('network')).toBeNull();
	});
});

test('a malformed existing journal blocks new work instead of being reset', async () => {
	await fixture((journal, directory) => {
		const initial = record();
		journal.begin(initial);
		const database = new Database(join(directory, 'native-operations/mutations.sqlite'));
		try {
			database.query('UPDATE mutations SET record = ?').run('{');
		} finally {
			database.close();
		}
		expect(() => journal.read('network')).toThrow();
		expect(() => journal.begin(record())).toThrow();
		expect(() => journal.finish('network', initial.operationId, 0, true)).toThrow();
	});
});

test('recovery data that cannot survive JSON persistence prevents the operation from starting', async () => {
	await fixture(journal => {
		expect(() => journal.begin({ ...record(), recoveryData: { metric: Number.NaN } })).toThrow('JSON-safe');
		expect(journal.read('network')).toBeNull();
	});
});
