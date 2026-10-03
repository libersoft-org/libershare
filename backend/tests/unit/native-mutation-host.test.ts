import { expectWorkerRejection } from '../helpers/worker-rejection.ts';
import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeMutationHost, type NativeMutationOptions } from '../../src/native/mutation-host.ts';
import { NativeWorkerChannel } from '../../src/native/worker-host.ts';
import type { NativeMutationRecord } from '../../src/native/mutation-journal.ts';
import type { NativeEndObservation } from '../../src/native/mutation-proof.ts';
import { NativeMutationJournal } from '../../src/native/mutation-journal.ts';

const entry = new URL('../helpers/native-blocking-worker.ts', import.meta.url).href;
const options: NativeMutationOptions = { domain: 'network', operation: 'ipv4', requestHash: 'b'.repeat(64), recoveryData: { original: '192.0.2.1' }, timeoutMs: 3000 };

test.each([false, true])('recovery retains helper metadata after a failed read (new boot: %s)', async newBoot => {
	await fixture(async (host, directory) => {
		const call = NativeWorkerChannel.prototype.call;
		let receipts = 0;
		let expectedBoot: string | null | undefined;
		const mock = spyOn(NativeWorkerChannel.prototype, 'call').mockImplementation(async function <T>(this: NativeWorkerChannel, request: Parameters<typeof call>[0], timeoutMs?: number): Promise<T> {
			if (request.method === 'helper.receipt') {
				receipts++;
				expect((request.args as { expectedBootId: string | null }).expectedBootId).toBe(expectedBoot!);
				return { recoveryData: { target: '192.0.2.2' } } as T;
			}
			return call.call(this, request, timeoutMs) as Promise<T>;
		});
		try {
			await host.run(
				options,
				context => context.pending({ kind: 'helper', operationId: context.operationId, requestHash: 'b'.repeat(64), cancelPath: join(directory, 'cancel'), launcher: null }),
				async () => 'completed'
			);
			await expectWorkerRejection(
				host.recover(
					'network',
					async record => {
						expectedBoot = record.bootId;
						return { ...observation(record), ...(newBoot ? { bootId: 'another-host-boot' } : {}), helper: { operationId: record.operationId, requestHash: record.requestHash, state: 'ended' } };
					},
					async record => {
						expect(record.recoveryData).toEqual({ original: '192.0.2.1', target: '192.0.2.2' });
						throw new Error('Temporary read failure');
					}
				),
				'Temporary read failure'
			);
			await host.recover(
				'network',
				async record => observation(record),
				async record => {
					expect(record.recoveryData).toEqual({ original: '192.0.2.1', target: '192.0.2.2' });
					return 'completed';
				}
			);
			expect(receipts).toBe(1);
			expect(await host.state('network')).toBeUndefined();
		} finally {
			mock.mockRestore();
		}
	});
});

test('a returned checkpoint call retains its receiver until scheduled work is settled', async () => {
	await fixture(async (host, directory) => {
		const rule = { kind: 'dbus-process' as const, destination: ':1.42', busId: 'a'.repeat(32), process: { pid: 42, started: 'linux-starttime:123' } };
		const result = await host.run(
			options,
			async context => {
				await context.call(rule, async () => ({ known: true, value: '/checkpoint/1' }));
				await context.recordRecovery({ checkpoint: '/checkpoint/1' });
				const journal = new NativeMutationJournal(directory);
				try {
					const record = journal.read('network')!.record;
					expect(record.endRule).toEqual(rule);
					expect(record.executorReturned).toBe(false);
					expect(record.recoveryData).toEqual({ original: '192.0.2.1', checkpoint: '/checkpoint/1' });
				} finally {
					journal.close();
				}
				await context.pending(rule);
			},
			async () => {
				throw new Error('Scheduled rollback has not finished');
			}
		);
		expect(result.state).toBe('pending');
		await host.recover(
			'network',
			async record => ({ ...observation(record), busId: rule.busId, service: { identity: rule.process, state: 'running' } }),
			async () => {
				throw new Error('Receiver still runs');
			}
		);
		expect(await host.state('network')).toMatchObject({ state: 'pending' });
		await host.recover(
			'network',
			async record => ({ ...observation(record), busId: rule.busId, service: { identity: rule.process, state: 'ended' } }),
			async () => 'completed'
		);
		expect(await host.state('network')).toBeUndefined();
	});
});

async function fixture(run: (host: NativeMutationHost, directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), 'native-mutation-host-'));
	const host = new NativeMutationHost(directory);
	try {
		await run(host, directory);
	} finally {
		expect(await host.closeAndDrain()).toBe(true);
		await rm(directory, { recursive: true, force: true });
	}
}

function observation(record: NativeMutationRecord, bootId: string | null = record.bootId): NativeEndObservation {
	return { bootId, executor: { identity: record.executor, state: 'running' } };
}

test('a UI timeout leaves the native call alive and prevents another write or acknowledgement', async () => {
	await fixture(async host => {
		const worker = new NativeWorkerChannel('mutation', entry);
		let secondStep = false;
		let settled = false;
		const marker = new Int32Array(new SharedArrayBuffer(8));
		try {
			await worker.call({ method: 'read', args: {} });
			const result = await host.run(
				{ ...options, timeoutMs: 1000 },
				async context => {
					await context.call({ kind: 'boot' }, async () => ({ known: true, value: await worker.call({ method: 'block', args: { milliseconds: 1500, marker } }) }));
					await context.call({ kind: 'executor' }, async () => {
						secondStep = true;
						return { known: true, value: 0 };
					});
				},
				async () => {
					settled = true;
					return 'completed';
				}
			);
			expect(result.state).toBe('pending');
			expect(Atomics.load(marker, 0)).toBe(1);
			expect(Atomics.load(marker, 1)).toBe(0);
			expect(await host.state('network')).toMatchObject({ state: 'pending' });
			await expectWorkerRejection(
				host.run(
					options,
					async () => {},
					async () => 'completed'
				),
				'has not finished'
			);
			await expectWorkerRejection(host.acknowledge('network'), 'has not finished');
			expect(worker.close()).toBe(false);
			const deadline = performance.now() + 3000;
			while (await host.state('network')) {
				if (performance.now() > deadline) throw new Error('Mutation did not settle');
				await Bun.sleep(10);
			}
			expect(settled).toBe(true);
			expect(secondStep).toBe(false);
		} finally {
			worker.close();
		}
	});
});

test('a live unknown provider cannot be unlocked by repeated state reads or another backend', async () => {
	await fixture(async (host, directory) => {
		let followUp = false;
		const result = await host.run(
			options,
			async context => {
				try {
					await context.call({ kind: 'boot' }, async () => ({ known: false }));
				} catch {
					await context.call({ kind: 'executor' }, async () => {
						followUp = true;
						return { known: true, value: 0 };
					});
				}
			},
			async () => {
				throw new Error('Unknown operation cannot settle');
			}
		);
		expect(result.state).toBe('pending');
		expect(followUp).toBe(false);
		const reopened = new NativeMutationHost(directory);
		try {
			for (let i = 0; i < 3; i++) {
				await reopened.recover(
					'network',
					async record => observation(record),
					async () => 'completed'
				);
				expect(await reopened.state('network')).toMatchObject({ state: 'pending' });
			}
			await expectWorkerRejection(
				reopened.run(
					options,
					async () => {},
					async () => 'completed'
				),
				'has not finished'
			);
			await expectWorkerRejection(reopened.acknowledge('network'), 'has not finished');
			await reopened.recover(
				'network',
				async record => observation(record, 'new-boot'),
				async () => 'completed'
			);
			expect(await reopened.state('network')).toBeUndefined();
		} finally {
			expect(await reopened.closeAndDrain()).toBe(true);
		}
	});
});

test('an incomplete final state stays locked until explicitly acknowledged', async () => {
	await fixture(async host => {
		await expectWorkerRejection(
			host.run(
				options,
				async context => context.call({ kind: 'executor' }, async () => ({ known: true, value: 1 })),
				async () => 'interrupted'
			),
			'interrupted state'
		);
		expect(await host.state('network')).toMatchObject({ state: 'interrupted' });
		await expectWorkerRejection(
			host.run(
				options,
				async () => {},
				async () => 'completed'
			),
			'has not finished'
		);
		await host.acknowledge('network');
		expect(await host.state('network')).toBeUndefined();
	});
});

test('another backend cannot take recovery from a live settlement', async () => {
	await fixture(async (host, directory) => {
		const peer = new NativeMutationHost(directory);
		let finish!: () => void;
		let started!: () => void;
		const ready = new Promise<void>(resolve => {
			started = resolve;
		});
		const gate = new Promise<void>(resolve => {
			finish = resolve;
		});
		const work = host.run(
			options,
			async () => 9,
			async () => {
				started();
				await gate;
				return 'completed';
			}
		);
		try {
			await ready;
			await peer.recover(
				'network',
				async record => observation(record),
				async () => {
					throw new Error('Cannot take live settlement');
				}
			);
			expect(await peer.state('network')).toMatchObject({ state: 'settling' });
			finish();
			expect(await work).toEqual({ state: 'completed', value: 9 });
		} finally {
			finish();
			await work;
			await peer.closeAndDrain();
		}
	});
});

test('failed readback keeps settling and a later readback can finish without another mutation', async () => {
	await fixture(async host => {
		await expectWorkerRejection(
			host.run(
				options,
				async () => 1,
				async () => {
					throw new Error('State temporarily unavailable');
				}
			),
			'State temporarily unavailable'
		);
		expect(await host.state('network')).toMatchObject({ state: 'settling' });
		await host.recover(
			'network',
			async record => observation(record),
			async () => 'completed'
		);
		expect(await host.state('network')).toBeUndefined();
	});
});

test('a slow durable begin returns pending within the UI budget and never starts the expired action', async () => {
	await fixture(async (host, directory) => {
		const call = NativeWorkerChannel.prototype.call;
		let release!: () => void;
		let starting!: () => void;
		const began = new Promise<void>(resolve => {
			starting = resolve;
		});
		const blocked = new Promise<void>(resolve => {
			release = resolve;
		});
		const mock = spyOn(NativeWorkerChannel.prototype, 'call').mockImplementation(async function <T>(this: NativeWorkerChannel, request: Parameters<typeof call>[0], timeoutMs?: number): Promise<T> {
			if (request.method === 'journal.begin' && (request.args as { directory: string }).directory === directory) {
				starting();
				await blocked;
			}
			return call.call(this, request, timeoutMs) as Promise<T>;
		});
		let invoked = false;
		try {
			const run = host.run(
				{ ...options, timeoutMs: 150 },
				async () => {
					invoked = true;
				},
				async () => 'completed'
			);
			await began;
			expect((await run).state).toBe('pending');
			expect(await host.state('network')).toMatchObject({ state: 'pending', operation: options.operation });
			expect(host.close()).toBe(false);
			release();
			const deadline = performance.now() + 3000;
			while (!host.close()) {
				if (performance.now() > deadline) throw new Error('Timed out begin did not finish');
				await Bun.sleep(10);
			}
			expect(invoked).toBe(false);
		} finally {
			release();
			mock.mockRestore();
		}
	});
});

test.each([1, 2])('journal update failure at step %i cannot lose proof or permit a later native step', async failureAt => {
	await fixture(async (host, directory) => {
		const call = NativeWorkerChannel.prototype.call;
		let updates = 0;
		const mock = spyOn(NativeWorkerChannel.prototype, 'call').mockImplementation(async function <T>(this: NativeWorkerChannel, request: Parameters<typeof call>[0], timeoutMs?: number): Promise<T> {
			if (request.method === 'journal.update' && (request.args as { directory: string }).directory === directory && ++updates === failureAt) throw new Error('database is locked');
			return call.call(this, request, timeoutMs) as Promise<T>;
		});
		let invoked = false;
		let laterStep = false;
		try {
			await expectWorkerRejection(
				host.run(
					options,
					async context => {
						try {
							await context.call({ kind: 'boot' }, async () => {
								invoked = true;
								return { known: true, value: 1 };
							});
						} catch (error) {
							await expectWorkerRejection(
								context.call({ kind: 'boot' }, async () => {
									laterStep = true;
									return { known: true, value: 2 };
								}),
								'budget expired'
							);
							throw error;
						}
					},
					async () => 'completed'
				),
				'database is locked'
			);
			expect(invoked).toBe(failureAt === 2);
			expect(laterStep).toBe(false);
			expect(await host.state('network')).toBeUndefined();
		} finally {
			mock.mockRestore();
		}
	});
});

test('a local completion proof cannot take over a newer recovery revision', async () => {
	await fixture(async (host, directory) => {
		await expectWorkerRejection(
			host.run(
				options,
				async () => 1,
				async () => {
					throw new Error('Readback unavailable');
				}
			),
			'Readback unavailable'
		);
		const peer = new NativeMutationHost(directory);
		let release!: () => void;
		let started!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const ready = new Promise<void>(resolve => {
			started = resolve;
		});
		const recovery = peer.recover(
			'network',
			async record => observation(record),
			async () => {
				started();
				await gate;
				return 'completed';
			}
		);
		try {
			await ready;
			await host.recover(
				'network',
				async record => observation(record),
				async () => {
					throw new Error('Cannot take another recovery');
				}
			);
			expect(await host.state('network')).toMatchObject({ state: 'settling' });
			release();
			await recovery;
			expect(await host.state('network')).toBeUndefined();
		} finally {
			release();
			await recovery;
			await peer.closeAndDrain();
		}
	});
});
