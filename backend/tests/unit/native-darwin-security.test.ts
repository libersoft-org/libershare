import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeWorkerChannel } from '../../src/native/worker-host.ts';
import { readMacCodeIdentity, type MacCodeIdentity } from '../../src/native/darwin/security.ts';

test('macOS signature verification requires a worker', () => {
	expect(() => readMacCodeIdentity('/example')).toThrow('requires a worker');
});

test.skipIf(process.platform !== 'darwin')('macOS rejects unsigned files and absent signing targets', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'native-signature-'));
	const channel = new NativeWorkerChannel('read');
	try {
		const path = join(directory, 'unsigned');
		await writeFile(path, 'unsigned test data');
		for (const target of [path, join(directory, 'missing')]) expect(await channel.call<MacCodeIdentity | null>({ method: 'darwin.signature', args: { path: target } }, 10000)).toBeNull();
	} finally {
		channel.close();
		await rm(directory, { recursive: true, force: true });
	}
});
