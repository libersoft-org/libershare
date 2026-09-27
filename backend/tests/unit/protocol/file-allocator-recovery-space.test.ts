import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodedError, ErrorCodes } from '@shared';
import { Downloader } from '../../../src/protocol/downloader.ts';
import { MockNetwork } from '../helpers/mock-network.ts';
import { MockDataServer, makeLISH, makeMissingChunk } from './downloader-test-helpers.ts';

for (const method of ['allocateStructure', 'allocateFiles', 'allocateFile']) {
	test(`${method} refuses a sparse replacement and a missing file before truncation`, async () => {
		const dir = await mkdtemp(join(tmpdir(), 'lish-alloc-recovery-'));
		const script = `
			import { mock } from 'bun:test';
			const fsp = { ...(await import('node:fs/promises')) };
			let writes = 0;
			mock.module('node:fs/promises', () => ({
				...fsp, statfs: async () => ({ bavail: 1, bsize: 1 }),
				open: async (...args) => { if (args[1] === 'w') writes++; return fsp.open(...args); },
			}));
			const { FileAllocator } = await import('./src/protocol/file-allocator.ts');
			const dir = ${JSON.stringify(dir)};
			const handle = await fsp.open(dir + '/sparse.bin', 'w');
			await handle.truncate(4095);
			await handle.close();
			const errors = [];
			for (const path of ['sparse.bin', 'missing.bin']) {
				const lish = { id: 'test', files: [{ path, size: 4096 }] };
				const allocator = new FileAllocator(dir);
				const method = ${JSON.stringify(method)};
				const args = method === 'allocateStructure' ? [lish] : [lish, method === 'allocateFile' ? 0 : [0]];
				errors.push(await allocator[method](...args).then(() => null, error => error.code));
			}
			console.log(JSON.stringify({ errors, writes, sparseSize: (await fsp.stat(dir + '/sparse.bin')).size, files: await fsp.readdir(dir) }));
		`;
		try {
			const proc = Bun.spawn([process.execPath, '--eval', script], { cwd: join(import.meta.dir, '../../..'), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
			const [code, output, error] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
			if (code !== 0) throw new Error(error);
			const lines = output.trim().split('\n');
			expect(JSON.parse(lines[lines.length - 1]!)).toEqual({ errors: [ErrorCodes.DISK_FULL, ErrorCodes.DISK_FULL], writes: 0, sparseSize: 4095, files: ['sparse.bin'] });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
}

for (const phase of ['before transfer', 'after transfer']) {
	test(`recovery ${phase} exposes DISK_FULL without resetting file chunks`, async () => {
		const ds = new MockDataServer();
		const dl: any = new Downloader('.', new MockNetwork() as never, ds as never, 'net-test');
		await dl.initFromManifest(makeLISH());
		dl.state = 'downloading';
		dl.missingChunks = phase === 'before transfer' ? [] : [makeMissingChunk('c' as never)];
		dl.fileAllocator.findMissingFiles = async () => [0];
		dl.fileAllocator.allocateFile = async () => { throw new CodedError(ErrorCodes.DISK_FULL, 'insufficient space'); };
		let resets = 0;
		ds.resetFileChunks = () => { resets++; return 0; };
		if (phase === 'after transfer') {
			dl.peerManager.size = () => 1;
			dl.chunkDownloader.run = async () => {};
		}
		try {
			await dl.doWork();
			expect(dl.getError()).toEqual({ code: ErrorCodes.DISK_FULL, detail: 'insufficient space' });
			expect(resets).toBe(0);
		} finally {
			await dl.destroy();
		}
	});
}
