import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moveDatasetData } from '../../../src/lish/dataset-transfer.ts';
import type { ILISH } from '@shared';

test.skipIf(process.platform !== 'win32')(
	'services timers while Windows copies and verifies a large file',
	async () => {
		const base = await mkdtemp(join(tmpdir(), 'lish-responsive-'));
		let timer: ReturnType<typeof setInterval> | undefined;
		try {
			const source = join(base, 'source');
			await mkdir(source);
			const chunkSize = 1024 * 1024;
			const bytes = Buffer.alloc(32 * chunkSize, 0x73);
			await writeFile(join(source, 'data.bin'), bytes);
			const hash = (value: Uint8Array): string => new Bun.CryptoHasher('sha256').update(value).digest('hex');
			const checksum = hash(bytes.subarray(0, chunkSize));
			const manifest: ILISH = { id: 'responsive-copy', created: '2026-01-01', chunkSize, checksumAlgo: 'sha256', files: [{ path: 'data.bin', size: bytes.length, checksums: Array(32).fill(checksum) }] };
			let ticks = 0;
			let ticksDuringCopy = 0;
			let lastTick = performance.now();
			let maxDelay = 0;
			let committed = false;
			await moveDatasetData(
				manifest,
				{ kind: 'derived', base, component: 'source' },
				{ kind: 'derived', base, component: 'target' },
				() => {
					committed = true;
				},
				event => {
					if (event.type === 'file-list') {
						lastTick = performance.now();
						timer = setInterval(() => {
							const now = performance.now();
							maxDelay = Math.max(maxDelay, now - lastTick);
							lastTick = now;
							ticks++;
						}, 1);
					}
					if (event.type === 'file') {
						maxDelay = Math.max(maxDelay, performance.now() - lastTick);
						ticksDuringCopy = ticks;
						clearInterval(timer);
					}
				}
			);
			expect(committed).toBe(true);
			expect(hash(await readFile(join(base, 'target/data.bin')))).toBe(hash(bytes));
			console.info(`Windows copy responsiveness: ${ticksDuringCopy} timer ticks, maximum gap ${maxDelay.toFixed(1)} ms`);
			expect(ticksDuringCopy).toBeGreaterThan(0);
			expect(maxDelay).toBeLessThan(500);
		} finally {
			clearInterval(timer);
			await rm(base, { recursive: true, force: true });
		}
	},
	30000
);
