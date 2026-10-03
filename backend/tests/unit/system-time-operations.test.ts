import { expect, test } from 'bun:test';
import { runOperations, withSaveBudget, type SystemOperation } from '../../src/system-time-common.ts';
import { NativeMutationUnknown, type NativeMutationContext } from '../../src/native/mutation-host.ts';
import { withNativeMutationContext } from '../../src/native/mutation-context.ts';

test('an active native operation may finish after the budget but no next write begins', async () => {
	let clock = 0;
	const calls: string[] = [];
	const operations: SystemOperation[] = [
		{
			describe: 'first',
			run: async () => {
				calls.push('first');
				clock = 200;
				return { kind: 'ok', output: '' };
			},
		},
		{
			describe: 'second',
			run: async () => {
				calls.push('second');
				return { kind: 'ok', output: '' };
			},
		},
	];
	const result = await withSaveBudget(
		() => runOperations('linux', operations, () => clock),
		() => clock,
		100
	);
	expect(calls).toEqual(['first']);
	expect(result).toMatchObject({ success: false, outcome: 'error', changed: true, stateMayHaveChanged: true });
});
test('an expired budget reports unchanged without invoking a native operation', async () => {
	let clock = 0,
		called = false;
	const result = await withSaveBudget(
		() => {
			clock = 101;
			return runOperations(
				'darwin',
				[
					{
						describe: 'write',
						run: async () => {
							called = true;
							return { kind: 'ok', output: '' };
						},
					},
				],
				() => clock
			);
		},
		() => clock,
		100
	);
	expect(called).toBe(false);
	expect(result).toMatchObject({ changed: false, stateMayHaveChanged: false });
});
test('native denial and partial mutation flags survive the shared sequence', async () => {
	for (const partial of [false, true]) {
		const result = await runOperations('win32', [{ describe: 'write', run: async () => ({ kind: 'denied', output: 'Access denied', changed: partial, stateMayHaveChanged: partial }) }]);
		expect(result).toMatchObject({ success: false, outcome: 'permission-denied', changed: partial, stateMayHaveChanged: partial });
	}
});
test('unknown execution keeps its end proof and never enters a following operation', async () => {
	let next = false,
		pending = false;
	const unexpected = async (): Promise<never> => {
		throw new Error('Unexpected context method');
	};
	const context: NativeMutationContext = {
		operationId: crypto.randomUUID(),
		dataDirectory: process.cwd(),
		remainingMs: () => 10000,
		call: unexpected,
		recordExecution: unexpected,
		recordRecovery: unexpected,
		pending: async rule => {
			expect(rule).toEqual({ kind: 'boot' });
			pending = true;
			throw new NativeMutationUnknown();
		},
	};
	await expect(
		withNativeMutationContext(context, () =>
			runOperations('win32', [
				{ describe: 'RPC', run: async () => ({ kind: 'unknown', output: 'disconnected', endRule: { kind: 'boot' } }) },
				{
					describe: 'next',
					run: async () => {
						next = true;
						return { kind: 'ok', output: '' };
					},
				},
			])
		)
	).rejects.toBeInstanceOf(NativeMutationUnknown);
	expect(pending).toBe(true);
	expect(next).toBe(false);
});
test('an explicit native refusal retains its outcome rather than inspecting localized text', async () => {
	const result = await runOperations('linux', [{ describe: 'clock', run: async () => ({ kind: 'failed', code: null, output: 'The host changed', outcome: 'stale', stateMayHaveChanged: false }) }]);
	expect(result).toMatchObject({ outcome: 'stale', changed: false, stateMayHaveChanged: false });
});
