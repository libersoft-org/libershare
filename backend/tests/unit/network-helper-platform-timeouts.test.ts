import { expect, test } from 'bun:test';
import { join } from 'node:path';

for (const scenario of ['linux', 'win32', 'win32-warm']) {
	test.skipIf(scenario !== 'linux' && process.platform !== 'win32')(`${scenario} verification timeout follows the real helper path without elevation`, async () => {
		const script = String.raw`
			import { mock } from 'bun:test';
			const fs = { ...(await import('node:fs')) };
			const fsp = { ...(await import('node:fs/promises')) };
			const cp = { ...(await import('node:child_process')) };
			const ffi = { ...(await import('bun:ffi')) };
			const { PassThrough } = await import('node:stream');
			const { join } = await import('node:path');
			const { createHash } = await import('node:crypto');
			const scenario = ${JSON.stringify(scenario)};
			let timeout = scenario !== 'win32-warm';
			let hashes = 0, signatures = 0, launchers = 0, prompts = 0, writes = 0;
			const { HelperVerificationTimeoutError } = await import('./src/network-helper-integrity.ts');
			globalThis.LISH_NETWORK_HELPER_SHA256 = createHash('sha256').update('test-helper').digest('hex');
			mock.module('node:fs', () => ({ ...fs, existsSync: () => true,
				mkdirSync: () => { writes++; throw new Error('unexpected directory write'); },
				writeFileSync: () => { writes++; throw new Error('unexpected file write'); },
				createReadStream: () => {
					hashes++;
					const stream = new PassThrough();
					queueMicrotask(() => timeout ? stream.destroy(new HelperVerificationTimeoutError()) : stream.end('test-helper'));
					return stream;
				},
			}));
			mock.module('node:fs/promises', () => ({ ...fsp, realpath: async path => path,
				stat: async () => ({ size: 1, mtimeMs: 1, ctimeMs: 1, ino: 1, uid: 0, mode: 0o755, isFile: () => true, isDirectory: () => true }),
			}));
			mock.module('bun:ffi', () => ({ ...ffi, dlopen: (library, declarations) => {
				const handle = ffi.dlopen(library, declarations);
				const symbols = { ...handle.symbols };
				if (symbols.ShellExecuteExW) symbols.ShellExecuteExW = () => { prompts++; return 0; };
				for (const name of ['CreateFileW', 'WriteFile']) if (symbols[name]) symbols[name] = () => { writes++; throw new Error('unexpected native file write'); };
				return { ...handle, symbols };
			} }));
			mock.module('node:child_process', () => ({ ...cp,
				spawn: () => { prompts++; throw new Error('unexpected helper spawn'); },
				execFile: (file, args, options, callback) => {
					const done = typeof options === 'function' ? options : callback;
					if (file.toLowerCase().endsWith('powershell.exe')) { signatures++; done(null, { stdout: '', stderr: '' }); return; }
					if (!file.endsWith('lish-network-launcher.exe')) { done(new Error('unexpected executable')); return; }
					launchers++;
					const argv = process.argv, executable = process.execPath;
					process.argv = [file, 'launcher', ...args]; process.execPath = file;
					import('./src/network-helper-windows-launcher.ts').then(() => {
						const code = Number(process.exitCode ?? 0);
						process.argv = argv; process.execPath = executable; process.exitCode = 0;
						done(code ? Object.assign(new Error('launcher exit'), { code }) : null, { stdout: '', stderr: '' });
					}, done);
				},
			}));
			if (scenario !== 'linux') {
				const { windowsProgramFilesPath } = await import('./src/network-helper-windows.ts');
				process.execPath = join(windowsProgramFilesPath(), 'Example', 'lish-backend.exe');
			}
			const { networkHelperAvailable, runElevatedSystemTime } = await import('./src/network-helper-client.ts');
			if (scenario === 'win32-warm') {
				if (!await networkHelperAvailable('win32')) throw new Error('warm-up did not verify the files');
				timeout = true;
			}
			const result = await runElevatedSystemTime({ ntpEnabled: false }, scenario === 'linux' ? 'linux' : 'win32', () => 1000);
			await Bun.sleep(50);
			console.log(JSON.stringify({ result, hashes, signatures, launchers, prompts, writes }));
		`;
		const child = Bun.spawn([process.execPath, '--eval', script], { cwd: join(import.meta.dir, '../..'), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
		const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		if (code !== 0) throw new Error(err);
		const result = JSON.parse(out.trim());
		expect(result.result.outcome).toBe('error');
		expect(result.result.stateMayHaveChanged).toBeUndefined();
		expect(result.prompts).toBe(0);
		expect(result.writes).toBe(0);
		expect(result.hashes).toBe(scenario === 'win32-warm' ? 2 : 1);
		expect(result.signatures).toBe(scenario === 'win32-warm' ? 1 : 0);
		expect(result.launchers).toBe(scenario === 'win32-warm' ? 1 : 0);
	});
}
