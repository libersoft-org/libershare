import { expect, test } from 'bun:test';
import { join } from 'node:path';

test.skipIf(process.platform !== 'win32')('a shared trust timeout prevents a late realpath from starting either helper hash', async () => {
	const script = `
		import { mock } from 'bun:test';
		const fs = { ...(await import('node:fs')) };
		const fsp = { ...(await import('node:fs/promises')) };
		const { PassThrough } = await import('node:stream');
		const { join } = await import('node:path');
		const { createHash } = await import('node:crypto');
		globalThis.LISH_NETWORK_HELPER_SHA256 = createHash('sha256').update('test-helper').digest('hex');
		let hashes = 0;
		let metadataReads = 0;
		mock.module('node:fs', () => ({ ...fs, createReadStream: () => {
			hashes++;
			const stream = new PassThrough();
			queueMicrotask(() => stream.end('test-helper'));
			return stream;
		} }));
		mock.module('node:fs/promises', () => ({ ...fsp,
			stat: async () => ({ size: 1, mtimeMs: 1, ctimeMs: 1, ino: 1 }),
			realpath: async path => { metadataReads++; await Bun.sleep(150); return path; },
		}));
		const { windowsProgramFilesPath } = await import('./src/network-helper-windows.ts');
		const folder = join(windowsProgramFilesPath(), 'Example');
		process.execPath = join(folder, 'lish-backend.exe');
		const { verifyWindowsHelper } = await import('./src/network-helper-client.ts');
		const helper = join(folder, 'lish-network-helper.exe');
		const clock = () => { let first = true; return () => first ? (first = false, 0) : 29980; };
		const results = await Promise.all([verifyWindowsHelper(helper, clock()), verifyWindowsHelper(helper, clock())].map(p => p.then(() => 'resolved', e => e.name)));
		await Bun.sleep(250);
		console.log(JSON.stringify({ results, hashes, metadataReads }));
	`;
	const proc = Bun.spawn([process.execPath, '--eval', script], { cwd: join(import.meta.dir, '../..'), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
	const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if (code !== 0) throw new Error(err);
	expect(JSON.parse(out.trim())).toEqual({ results: ['HelperVerificationTimeoutError', 'HelperVerificationTimeoutError'], hashes: 0, metadataReads: 2 });
});
