import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, unlink, rename, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Database } from 'bun:sqlite';
import type { ILISH } from '@shared';
import { DataServer } from '../../../src/lish/data-server.ts';
import { DatasetWriteScope } from '../../../src/lish/dataset-write-scope.ts';
import { SafeDataset, openDataset, type DatasetRoot } from '../../../src/lish/safe-dataset-files.ts';
import { openWindowsDatasetDirectory } from '../../../src/lish/safe-dataset-files-windows.ts';
import { openPosixDatasetDirectory } from '../../../src/lish/safe-dataset-files-posix.ts';

const scratch: string[] = [];
afterEach(async () => {
	for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture(count = 1) {
	const base = await mkdtemp(join(tmpdir(), 'dataset-write-scope-'));
	scratch.push(base);
	const directory = join(base, 'dataset');
	await mkdir(directory);
	const manifest: ILISH = { id: 'write-scope', created: '2026-01-01', chunkSize: 1, checksumAlgo: 'sha256', files: [] };
	for (let i = 0; i < count; i++) {
		const path = `file-${i}.bin`;
		await writeFile(join(directory, path), Buffer.alloc(20));
		manifest.files!.push({ path, size: 20, checksums: Array(20).fill('00') });
	}
	return { base, directory, manifest, root: { kind: 'explicit', path: directory } as DatasetRoot };
}

test('prepares 200 actual files once for 20 concurrent block writes', async () => {
	const f = await fixture(200);
	let roots = 0;
	const files: string[] = [];
	const open = async () => {
		roots++;
		const root = await (process.platform === 'win32' ? openWindowsDatasetDirectory(f.directory) : openPosixDatasetDirectory(f.directory));
		const openFile = root.openFile.bind(root);
		root.openFile = (name, mode) => {
			files.push(name);
			return openFile(name, mode);
		};
		return new SafeDataset(root);
	};
	const server = new DataServer({} as Database, open);
	const scope = new DatasetWriteScope();
	try {
		await Promise.all(Array.from({ length: 20 }, (_, index) => server.writeChunk(f.root, f.manifest, 0, index, new Uint8Array([index + 1]), scope)));
		expect(roots).toBe(1);
		expect(files).toHaveLength(220);
		expect(files.filter(name => name === 'file-199.bin')).toHaveLength(1);
		expect(await readFile(join(f.directory, 'file-0.bin'))).toEqual(Buffer.from(Array.from({ length: 20 }, (_, i) => i + 1)));
	} finally {
		await scope.close();
	}
});

test('rechecks the written file and refuses an identity replacement without preparing again', async () => {
	const f = await fixture();
	let preparations = 0;
	const server = new DataServer({} as Database, async root => {
		preparations++;
		return openDataset(root);
	});
	const scope = new DatasetWriteScope();
	try {
		await server.writeChunk(f.root, f.manifest, 0, 0, new Uint8Array([1]), scope);
		await rename(join(f.directory, 'file-0.bin'), join(f.directory, 'original'));
		await writeFile(join(f.directory, 'file-0.bin'), 'keep');
		await expect(server.writeChunk(f.root, f.manifest, 0, 1, new Uint8Array([2]), scope)).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
		expect(await readFile(join(f.directory, 'file-0.bin'), 'utf8')).toBe('keep');
		expect(preparations).toBe(1);
	} finally {
		await scope.close();
	}
});

test('reprepares after missing-file recovery but refuses a link inserted before retry', async () => {
	const f = await fixture();
	let preparations = 0;
	const server = new DataServer({} as Database, async root => {
		preparations++;
		return openDataset(root);
	});
	const scope = new DatasetWriteScope();
	try {
		await server.writeChunk(f.root, f.manifest, 0, 0, new Uint8Array([1]), scope);
		await unlink(join(f.directory, 'file-0.bin'));
		await expect(server.writeChunk(f.root, f.manifest, 0, 1, new Uint8Array([2]), scope)).rejects.toMatchObject({ code: 'ENOENT' });
		await writeFile(join(f.directory, 'file-0.bin'), Buffer.alloc(20));
		await server.writeChunk(f.root, f.manifest, 0, 1, new Uint8Array([2]), scope);
		expect(preparations).toBe(2);
		await unlink(join(f.directory, 'file-0.bin'));
		await expect(server.writeChunk(f.root, f.manifest, 0, 2, new Uint8Array([3]), scope)).rejects.toMatchObject({ code: 'ENOENT' });
		await writeFile(join(f.base, 'outside'), 'keep');
		await symlink(join(f.base, 'outside'), join(f.directory, 'file-0.bin'), 'file');
		await expect(server.writeChunk(f.root, f.manifest, 0, 2, new Uint8Array([3]), scope)).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
		expect(await readFile(join(f.base, 'outside'), 'utf8')).toBe('keep');
	} finally {
		await scope.close();
	}
});

test('close drains a held write and rejects later writes and a changed manifest', async () => {
	const f = await fixture();
	const scope = new DatasetWriteScope();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const operation = scope.write(f.root, f.manifest, openDataset, async dataset => {
		const file = await dataset.openFile('file-0.bin', 'write');
		try {
			entered.resolve();
			await release.promise;
			await file.write(new Uint8Array([7]), 0);
		} finally {
			await file.close();
		}
	});
	try {
		await entered.promise;
		await expect(scope.write(f.root, { ...f.manifest }, openDataset, async () => {})).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
		let closed = false;
		const closing = scope.close().then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		await expect(scope.write(f.root, f.manifest, openDataset, async () => {})).rejects.toMatchObject({ code: 'EBADF' });
		release.resolve();
		await operation;
		await closing;
		expect((await readFile(join(f.directory, 'file-0.bin')))[0]).toBe(7);
	} finally {
		release.resolve();
		await operation;
		await scope.close();
	}
});

test('does not follow a replaced parent between blocks', async () => {
	const f = await fixture();
	await mkdir(join(f.directory, 'sub'));
	await rename(join(f.directory, 'file-0.bin'), join(f.directory, 'sub/file.bin'));
	f.manifest.files![0]!.path = 'sub/file.bin';
	const server = new DataServer({} as Database);
	const scope = new DatasetWriteScope();
	try {
		await server.writeChunk(f.root, f.manifest, 0, 0, new Uint8Array([1]), scope);
		await rename(join(f.directory, 'sub'), join(f.directory, 'original'));
		await mkdir(join(f.base, 'outside'));
		await writeFile(join(f.base, 'outside/file.bin'), 'keep');
		await symlink(join(f.base, 'outside'), join(f.directory, 'sub'), process.platform === 'win32' ? 'junction' : 'dir');
		await expect(server.writeChunk(f.root, f.manifest, 0, 1, new Uint8Array([2]), scope)).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
		expect(await readFile(join(f.base, 'outside/file.bin'), 'utf8')).toBe('keep');
	} finally {
		await scope.close();
	}
});

test('does not accept a different root after missing-file recovery', async () => {
	const f = await fixture();
	const server = new DataServer({} as Database);
	const scope = new DatasetWriteScope();
	try {
		await server.writeChunk(f.root, f.manifest, 0, 0, new Uint8Array([1]), scope);
		await unlink(join(f.directory, 'file-0.bin'));
		await expect(server.writeChunk(f.root, f.manifest, 0, 1, new Uint8Array([2]), scope)).rejects.toMatchObject({ code: 'ENOENT' });
		await rename(f.directory, join(f.base, 'original'));
		await mkdir(join(f.base, 'outside'));
		await writeFile(join(f.base, 'outside/file-0.bin'), 'keep');
		await symlink(join(f.base, 'outside'), f.directory, process.platform === 'win32' ? 'junction' : 'dir');
		await expect(server.writeChunk(f.root, f.manifest, 0, 1, new Uint8Array([2]), scope)).rejects.toMatchObject({ code: 'LISH_UNSAFE_PATH' });
		expect(await readFile(join(f.base, 'outside/file-0.bin'), 'utf8')).toBe('keep');
	} finally {
		await scope.close();
	}
});

test.each(['open', 'prepare'])('retries a transient permission failure during %s', async phase => {
	const f = await fixture();
	let opens = 0;
	const denied = Object.assign(new Error('Temporarily denied'), { code: 'EACCES' });
	const server = new DataServer({} as Database, async root => {
		opens++;
		if (phase === 'open' && opens === 1) throw denied;
		const dataset = await openDataset(root);
		if (phase === 'prepare' && opens === 1)
			dataset.prepare = async () => {
				throw denied;
			};
		return dataset;
	});
	const scope = new DatasetWriteScope();
	try {
		await expect(server.writeChunk(f.root, f.manifest, 0, 0, new Uint8Array([1]), scope)).rejects.toMatchObject({ code: 'EACCES' });
		await server.writeChunk(f.root, f.manifest, 0, 0, new Uint8Array([1]), scope);
		expect(opens).toBe(2);
		expect((await readFile(join(f.directory, 'file-0.bin')))[0]).toBe(1);
	} finally {
		await scope.close();
	}
});
