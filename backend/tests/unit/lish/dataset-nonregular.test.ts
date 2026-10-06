import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it.skipIf(process.platform === 'win32')(
	'rejects a FIFO target without waiting for a writer',
	async () => {
		const directory = await mkdtemp(join(tmpdir(), 'lish-fifo-'));
		try {
			const create = Bun.spawn(['mkfifo', join(directory, 'file.bin')], { stdout: 'pipe', stderr: 'pipe' });
			if ((await create.exited) !== 0) throw new Error(await new Response(create.stderr).text());
			const source = `
			import { FileAllocator } from './src/protocol/file-allocator.ts';
			await new FileAllocator(${JSON.stringify(directory)}).findMissingFiles({ files: [{ path: 'file.bin', size: 4 }] })
				.then(() => console.log('accepted'), error => console.log(error.code));
		`;
			const child = Bun.spawn([process.execPath, '--eval', source], { cwd: join(import.meta.dir, '../../..'), stdout: 'pipe', stderr: 'pipe' });
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill();
			}, 3000);
			try {
				const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
				expect(timedOut).toBe(false);
				if (code !== 0) throw new Error(error);
				expect(output.trim()).toBe('LISH_UNSAFE_PATH');
			} finally {
				clearTimeout(timer);
				if (child.exitCode === null) {
					child.kill();
					await child.exited;
				}
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
	10_000
);
