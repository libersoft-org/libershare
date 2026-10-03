import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { ErrorCodes } from '@shared';
import { ErrorRecovery } from '../../../src/api/error-recovery.ts';

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('Recovery did not settle');
		await Bun.sleep(5);
	}
}

function fixture() {
	let entered = Promise.withResolvers<void>();
	let access = Promise.withResolvers<void>();
	let attempts = 0;
	const events: string[] = [];
	const recovery = new ErrorRecovery({
		attemptRecover: async () => {
			attempts++;
			return true;
		},
		broadcast: event => {
			events.push(event);
		},
		getLISH: id => ({ id, directory: tmpdir() }),
		checkAccess: async () => {
			entered.resolve();
			await access.promise;
		},
	});
	const id = 'paused-retry';
	recovery.start(id, ErrorCodes.DISK_FULL, { downloadEnabled: true, uploadEnabled: true });
	return {
		recovery,
		id,
		events,
		attempts: () => attempts,
		async begin() {
			await recovery.pauseAllAndDrain();
			entered = Promise.withResolvers<void>();
			access = Promise.withResolvers<void>();
			const state = recovery.getState(id)!;
			state.scheduledAt = Date.now() - state.nextRetryDelay;
			recovery.resumeAll();
			await entered.promise;
		},
		finish(failed = false) {
			if (failed) access.reject(new Error('inaccessible'));
			else access.resolve();
		},
		async close() {
			access.resolve();
			await recovery.stopAllAndDrain();
		},
	};
}

for (const accessFails of [false, true])
	test(`maintenance does not spend attempts while access is pending, accessFails=${accessFails}`, async () => {
		const f = fixture();
		try {
			for (let round = 0; round < 6; round++) {
				await f.begin();
				const pausing = f.recovery.pauseAllAndDrain();
				f.finish(accessFails);
				await pausing;
				expect(f.recovery.getState(f.id)?.retryCount).toBe(0);
				// Recreating the entry also checks the separate cumulative retry budget.
				f.recovery.stop(f.id);
				f.recovery.start(f.id, ErrorCodes.DISK_FULL, { downloadEnabled: true, uploadEnabled: true });
				expect(f.recovery.getState(f.id)?.retryCount).toBe(0);
			}
			expect(f.attempts()).toBe(0);
			await f.begin();
			f.finish();
			await until(() => f.attempts() === 1);
			expect(f.events).toContain('transfer.recovery:recovered');
			expect(f.events).not.toContain('transfer.recovery:exhausted');
		} finally {
			await f.close();
		}
	});

test('a pause near the retry limit preserves earlier failures and permits the next recovery', async () => {
	const f = fixture();
	try {
		for (let failure = 1; failure <= 3; failure++) {
			await f.begin();
			f.finish(true);
			await until(() => f.recovery.getState(f.id)?.timer != null);
			expect(f.recovery.getState(f.id)?.retryCount).toBe(failure);
		}
		await f.begin();
		const pausing = f.recovery.pauseAllAndDrain();
		f.finish();
		await pausing;
		expect(f.recovery.getState(f.id)?.retryCount).toBe(3);
		f.recovery.stop(f.id);
		f.recovery.start(f.id, ErrorCodes.DISK_FULL, { downloadEnabled: true, uploadEnabled: true });
		expect(f.recovery.getState(f.id)?.retryCount).toBe(3);
		await f.begin();
		f.finish();
		await until(() => f.attempts() === 1);
		expect(f.events).not.toContain('transfer.recovery:exhausted');
	} finally {
		await f.close();
	}
});

for (const first of ['download', 'upload'] as const)
	for (const failures of [0, 4])
		test(`completing both directions cancels recovery: ${first} first, ${failures} failures`, async () => {
			const f = fixture();
			const second = first === 'download' ? 'upload' : 'download';
			try {
				for (let failure = 0; failure < failures; failure++) {
					await f.begin();
					f.finish(true);
					await until(() => f.recovery.getState(f.id)?.timer != null);
				}
				await f.recovery.pauseAllAndDrain();
				const state = f.recovery.getState(f.id)!;
				state.scheduledAt = Date.now() - state.nextRetryDelay;
				f.recovery.resumeAll();
				const timer = state.timer;
				f.recovery.completeDirection(f.id, first);
				expect(f.recovery.getState(f.id)?.[`${first}WasEnabled`]).toBe(false);
				expect(f.recovery.getState(f.id)?.[`${second}WasEnabled`]).toBe(true);
				expect(f.recovery.getState(f.id)?.timer).toBe(timer);
				expect(f.recovery.getState(f.id)?.retryCount).toBe(failures);
				f.recovery.completeDirection(f.id, second);
				expect(f.recovery.getState(f.id)).toBeUndefined();
				await Bun.sleep(20);
				expect(f.attempts()).toBe(0);
				expect(f.events).not.toContain('transfer.recovery:exhausted');
				f.recovery.start(f.id, ErrorCodes.DISK_FULL, { downloadEnabled: true, uploadEnabled: true });
				expect(f.recovery.getState(f.id)?.retryCount).toBe(0);
			} finally {
				await f.close();
			}
		});

test('a new failure re-arms a completed direction while the other still waits', async () => {
	const f = fixture();
	try {
		f.recovery.completeDirection(f.id, 'download');
		expect(f.recovery.getState(f.id)?.downloadWasEnabled).toBe(false);
		f.recovery.start(f.id, ErrorCodes.DISK_FULL, { downloadEnabled: true, uploadEnabled: false });
		f.recovery.completeDirection(f.id, 'upload');
		expect(f.recovery.getState(f.id)?.downloadWasEnabled).toBe(true);
		expect(f.recovery.getState(f.id)?.uploadWasEnabled).toBe(false);
		await f.begin();
		f.finish();
		await until(() => f.attempts() === 1);
		expect(f.events).toContain('transfer.recovery:recovered');
	} finally {
		await f.close();
	}
});
