import { stat, statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { CodedError, ErrorCodes, formatBytes } from '@shared';

async function spaceAt(path: string): Promise<{ device: bigint; free: bigint }> {
	let existing = resolve(path);
	for (;;) {
		try {
			const info = await stat(existing, { bigint: true });
			const space = await statfs(existing, { bigint: true });
			return { device: BigInt(info.dev), free: BigInt(space.bavail) * BigInt(space.bsize) };
		} catch (error) {
			const parent = dirname(existing);
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === existing) throw new CodedError(ErrorCodes.DISK_SPACE_UNAVAILABLE);
			existing = parent;
		}
	}
}

function requireSpace(required: bigint, free: bigint, purpose: string): void {
	if (required > free) throw new CodedError(ErrorCodes.DISK_FULL, `${formatBytes(Number(required))} required for ${purpose}; ${formatBytes(Number(free))} free`);
}

/** Budget payload copies separately from moves that preserve the original file objects. */
export async function checkDatasetSpace(downloadPath: string, allocationBytes: bigint, completion?: { path: string; bytes: bigint; sameFilesystemBytes?: bigint }): Promise<void> {
	if (allocationBytes === 0n && (!completion || completion.bytes === 0n)) return;
	const download = await spaceAt(downloadPath);
	if (!completion) {
		requireSpace(allocationBytes, download.free, 'file allocation');
		return;
	}
	const target = await spaceAt(completion.path);
	if (download.device === target.device) {
		requireSpace(allocationBytes + (completion.sameFilesystemBytes ?? completion.bytes), download.free < target.free ? download.free : target.free, 'the download and its completion copy on the same filesystem');
	} else {
		requireSpace(allocationBytes, download.free, 'file allocation');
		requireSpace(completion.bytes, target.free, 'the completion copy on the destination filesystem');
	}
}

export async function checkDatasetCopySpace(destination: string, bytes: bigint): Promise<void> {
	if (bytes > 0n) requireSpace(bytes, (await spaceAt(destination)).free, 'the verified destination copy');
}
