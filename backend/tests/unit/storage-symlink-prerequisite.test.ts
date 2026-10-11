import { expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const code of ['ENOTSUP', 'EIO', ...(process.platform === 'win32' ? ['EPERM'] : [])]) {
	it(`reports unavailable symlink fixtures honestly for ${code}`, async () => {
		const dir = await mkdtemp(join(tmpdir(), 'lish-symlink-prerequisite-'));
		const preload = join(dir, 'fault.ts');
		try {
			await writeFile(
				preload,
				`
				import { mock } from 'bun:test';
				const fs = { ...(await import('node:fs')) };
				mock.module('node:fs', () => ({
					...fs,
					symlinkSync: () => { throw Object.assign(new Error('injected symlink failure: ${code}'), { code: '${code}' }); },
				}));
			`
			);
			// The JUnit report names every skipped test; the console reporter lists only failures
			// when it does not write to a terminal.
			const report = join(dir, 'report.xml');
			const child = Bun.spawn([process.execPath, 'test', '--preload', preload, '--reporter=junit', `--reporter-outfile=${report}`, 'tests/unit/storage-atomic-write.test.ts', 'tests/unit/api/settings-persistence-response.test.ts'], { cwd: join(import.meta.dir, '../..'), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
			const timeout = setTimeout(() => child.kill(), 10_000);
			try {
				const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
				const output = stdout + stderr;
				if (code === 'EIO') {
					expect(exitCode).not.toBe(0);
					expect(output).toContain('injected symlink failure: EIO');
				} else {
					if (exitCode !== 0) throw new Error(output);
					const xml = await readFile(report, 'utf8');
					expect(xml.match(/<skipped/g)?.length).toBe(7);
					expect(xml).toContain(`(${code})]`);
				}
			} finally {
				clearTimeout(timeout);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 15_000);
}
