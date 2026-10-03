import { expect, test } from 'bun:test';
import { join } from 'node:path';

for (const failure of ['read', 'signature', 'launch']) {
	test(`macOS ${failure} failure reports whether a helper could have started`, async () => {
		const script = String.raw`
			import { mock } from 'bun:test';
			const fs = { ...(await import('node:fs')) };
			const cp = { ...(await import('node:child_process')) };
			const { PassThrough } = await import('node:stream');
			let prompts = 0;
			const failure = ${JSON.stringify(failure)};
			mock.module('node:fs', () => ({ ...fs, createReadStream: () => {
				const stream = new PassThrough();
				queueMicrotask(() => failure === 'read' ? stream.destroy(new Error('helper read failed')) : stream.end('helper'));
				return stream;
			} }));
			mock.module('node:child_process', () => ({ ...cp, spawn: () => { prompts++; throw new Error('launch failed'); }, execFile: (file, args, options, callback) => {
				if (file.endsWith('osascript')) { prompts++; callback(new Error('launch failed')); return; }
				if (failure === 'signature') { callback(new Error('signature unavailable')); return; }
				callback(null, { stdout: '', stderr: 'TeamIdentifier=TEAMID\nIdentifier=app.example' });
			} }));
			const ownership = await import('./src/native/mutation-context.ts');
			const records = await import('./src/native/helper-results-store.ts');
			const context = {
				operationId: '00000000-0000-4000-8000-000000000001', dataDirectory: process.cwd(), remainingMs: () => 10000,
				recordExecution: async () => {},
				call: async (_rule, invoke) => {
					const result = await invoke();
					if (!result.known) throw new Error('unknown helper outcome');
					return result.value;
				},
			};
			mock.module('./src/native/mutation-context.ts', () => ({ ...ownership, requireNativeMutationContext: () => context }));
			mock.module('./src/native/helper-results-store.ts', () => ({ ...records, HelperResultStore: class { async read() { return failure === 'launch' ? { phase: 'started' } : null; } }, createHelperCancellation: async () => {} }));
			const { runElevatedSystemTime } = await import('./src/network-helper-client.ts');
			const result = await runElevatedSystemTime({ ntpEnabled: false }, 'darwin', () => 1000, async () => true);
			console.log(JSON.stringify({ result, prompts }));
		`;
		const child = Bun.spawn([process.execPath, '--eval', script], { cwd: join(import.meta.dir, '../..'), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
		const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		if (code !== 0) throw new Error(err);
		const proof = JSON.parse(out.trim());
		expect(proof.result.outcome).toBe('error');
		expect(proof.result.changed).toBeUndefined();
		expect(proof.result.stateMayHaveChanged).toBe(failure === 'launch' ? true : undefined);
		expect(proof.prompts).toBe(failure === 'launch' ? 1 : 0);
	});
}
