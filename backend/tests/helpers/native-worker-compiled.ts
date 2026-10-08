import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeMutationHost } from '../../src/native/mutation-host.ts';
import { NativeWorkerChannel } from '../../src/native/worker-host.ts';
import type { DarwinTimeSnapshot } from '../../src/native/darwin/time-state.ts';

const directory = await mkdtemp(join(tmpdir(), 'lish-native-compiled-'));
const host = new NativeMutationHost(directory);
const reader = new NativeWorkerChannel('read');
try {
	const identity = await reader.call<{ executor: { pid: number; started: string }; bootId: string | null }>({ method: 'identity.current' }, 5000);
	if (identity.executor.pid !== process.pid || !identity.executor.started) throw new Error('Wrong native worker identity');
	const result = await host.run(
		{ domain: 'network', operation: 'compiled-worker-check', requestHash: 'c'.repeat(64), recoveryData: null, timeoutMs: 5000 },
		async () => identity.executor.started,
		async () => 'completed'
	);
	if (result.state !== 'completed' || (await host.state('network'))) throw new Error('Compiled journal did not finish');
	if (process.platform === 'darwin') {
		const { prepareDarwinClock } = await import('../../src/native/darwin/time-native.ts');
		const inherited = process.env['TZ'];
		const clock = { hours: 12, minutes: 34, seconds: 56 };
		const expected = prepareDarwinClock(clock);
		const snapshot = await reader.call<DarwinTimeSnapshot>({ method: 'darwin.time.snapshot', args: { clock } }, 15000);
		if (snapshot.targetClock?.targetUtcMs !== expected.targetUtcMs || snapshot.bootId !== expected.reference.bootId) throw new Error('Compiled clock worker disagrees with the host conversion');
		if (process.env['TZ'] !== inherited) throw new Error('Compiled clock worker changed the inherited timezone');
		console.log(JSON.stringify({ compiledClock: true, inheritedTimezoneUnchanged: true }));
	}
	console.log(JSON.stringify({ platform: process.platform, arch: process.arch, nativeIdentity: true, durableMutation: true }));
} finally {
	reader.close();
	if (!(await host.closeAndDrain())) throw new Error('Compiled mutation remains active');
	await reader.waitUntilClosed();
	await rm(directory, { recursive: true, force: true });
}
