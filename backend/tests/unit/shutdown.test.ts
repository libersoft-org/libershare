import { describe, expect, it } from 'bun:test';
import { createProcessShutdown, type ProcessShutdownDeps } from '../../src/shutdown.ts';

function deps(log: string[], overrides: Partial<ProcessShutdownDeps> = {}): ProcessShutdownDeps {
	return {
		stopConnectivityCheck: () => log.push('connectivity'),
		stopApi: async () => {
			log.push('api');
		},
		flushSettings: async () => {
			log.push('settings');
		},
		closeDatabase: () => log.push('db'),
		exit: code => log.push(`exit ${code}`),
		...overrides,
	};
}

describe('process shutdown', () => {
	it('closes the database only after the API drained and the settings were flushed', async () => {
		const log: string[] = [];
		let release!: () => void;
		const held = new Promise<void>(r => (release = r));
		const { shutdown } = createProcessShutdown(
			deps(log, {
				stopApi: async () => {
					await held;
					log.push('api');
				},
			})
		);
		const running = shutdown();
		await Bun.sleep(20);
		// The old handler closed the database here, while the API was still draining.
		expect(log).toEqual(['connectivity']);
		release();
		await running;
		expect(log).toEqual(['connectivity', 'api', 'settings', 'db', 'exit 0']);
	});

	it('an API that does not stop exits 1 and leaves the database open', async () => {
		const log: string[] = [];
		const { shutdown } = createProcessShutdown(
			deps(log, {
				stopApi: async () => {
					throw new Error('network refused to stop');
				},
			})
		);
		await shutdown();
		expect(log).toEqual(['connectivity', 'exit 1']);
	});

	it('a settings write that never reached the disk still closes the database but exits 1', async () => {
		const log: string[] = [];
		const { shutdown } = createProcessShutdown(
			deps(log, {
				flushSettings: async () => {
					throw new Error('EIO');
				},
			})
		);
		await shutdown();
		expect(log).toEqual(['connectivity', 'api', 'db', 'exit 1']);
	});

	it('the deadline exits 1 without closing the database, and nothing runs after it', async () => {
		const log: string[] = [];
		let release!: () => void;
		const held = new Promise<void>(r => (release = r));
		const { shutdown } = createProcessShutdown(deps(log, { deadlineMs: 30, stopApi: () => held }));
		const running = shutdown();
		await Bun.sleep(60);
		expect(log).toEqual(['connectivity', 'exit 1']);
		release();
		await running;
		expect(log).toEqual(['connectivity', 'exit 1']);
	});

	it('a second signal forces exit 1; the API is reported as shutting down', async () => {
		const log: string[] = [];
		const { shutdown, isShuttingDown } = createProcessShutdown(deps(log, { stopApi: () => new Promise(() => {}), deadlineMs: 10_000 }));
		expect(isShuttingDown()).toBe(false);
		void shutdown();
		expect(isShuttingDown()).toBe(true);
		await shutdown();
		expect(log).toEqual(['connectivity', 'exit 1']);
	});
});
