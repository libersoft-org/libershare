import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('a slow metadata reader keeps its own deadline without cancelling shared verification', async () => {
	const script = String.raw`
		import { mock } from 'bun:test';
		const fs = { ...(await import('node:fs/promises')) };
		const cp = { ...(await import('node:child_process')) };
		const windows = { ...(await import('./src/network-helper-windows.ts')) };
		const metadata = Promise.withResolvers();
		const signatureStarted = Promise.withResolvers();
		let statCalls = 0, verifications = 0, signatures = 0, finishSignature;
		let firstNow = 0, secondSettled = false;
		globalThis.LISH_NETWORK_HELPER_SHA256 = 'a'.repeat(64);
		mock.module('node:fs/promises', () => ({ ...fs, stat: async () => {
			if (++statCalls <= 3) await metadata.promise;
			return { size: 1, mtimeMs: 1, ctimeMs: 1, ino: 1 };
		} }));
		mock.module('./src/network-helper-windows.ts', () => ({ ...windows,
			verifyWindowsInstalledHelper: async () => { verifications++; return true; },
			verifyWindowsInstalledSibling: async () => true,
			windowsPowerShellPath: () => 'powershell.exe',
			windowsSystemEnvironment: () => ({}),
		}));
		mock.module('node:child_process', () => ({ ...cp, execFile: (_file, _args, _options, callback) => {
			signatures++;
			finishSignature = () => callback(null, { stdout: '', stderr: '' });
			signatureStarted.resolve();
		} }));
		const { verifyWindowsHelper } = await import('./src/network-helper-client.ts');
		const helper = 'C:/Program Files/Example/lish-network-helper.exe';
		const first = verifyWindowsHelper(helper, () => firstNow).then(value => value, error => error.name);
		const second = verifyWindowsHelper(helper, () => 10000).then(value => { secondSettled = true; return value; });
		await signatureStarted.promise;
		// Metadata used all but 50 ms of A's budget; B still owns its later deadline.
		firstNow = 29950;
		metadata.resolve();
		let guard;
		const firstResult = await Promise.race([first, new Promise(resolve => { guard = setTimeout(() => resolve('still pending'), 1000); })]);
		clearTimeout(guard);
		const secondWasPending = !secondSettled;
		finishSignature();
		const secondResult = await second;
		await first;
		const cached = await verifyWindowsHelper(helper, () => 40000);
		console.log(JSON.stringify({ firstResult, secondWasPending, secondResult, cached, verifications, signatures }));
	`;
	const child = Bun.spawn([process.execPath, '--eval', script], { cwd: join(import.meta.dir, '../..'), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
	const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	if (code !== 0) throw new Error(err);
	expect(JSON.parse(out.trim())).toEqual({ firstResult: 'HelperVerificationTimeoutError', secondWasPending: true, secondResult: true, cached: true, verifications: 1, signatures: 1 });
});
